/**
 * Account reads that respect RPC limits. `getMultipleAccounts` takes at most 100 keys
 * (https://solana.com/docs/rpc/http/getmultipleaccounts); a watcher, board or loader that
 * grows past that must not fail as a whole. Keys are deduplicated, split into chunks of at
 * most 100, and read with bounded concurrency; results come back in the order asked, along
 * with the lowest slot any chunk was read at.
 */
import type { AccountInfo, Commitment, Connection, PublicKey } from "@solana/web3.js";

export const MAX_ACCOUNTS_PER_CALL = 100;

export interface LoadedAccounts {
  /** One entry per requested key: the account, null when it doesn't exist, undefined when its chunk failed (only with `partial`). */
  infos: (AccountInfo<Buffer> | null | undefined)[];
  /** The oldest slot any chunk was served at: the whole result is at least this fresh. */
  slot: number;
  /** Indexes (into the request) whose chunk failed; empty unless `partial`. */
  failed: number[];
}

export async function loadAccounts(
  conn: Connection,
  keys: PublicKey[],
  opts: { partial?: boolean; concurrency?: number; commitment?: Commitment; chunk?: number } = {},
): Promise<LoadedAccounts> {
  const size = Math.min(MAX_ACCOUNTS_PER_CALL, opts.chunk ?? MAX_ACCOUNTS_PER_CALL);
  const unique: PublicKey[] = [];
  const at = new Map<string, number>();
  for (const k of keys) {
    const s = k.toBase58();
    if (!at.has(s)) at.set(s, unique.push(k) - 1);
  }
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));

  const results: ({ infos: (AccountInfo<Buffer> | null)[]; slot: number } | Error)[] = new Array(chunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          const r = await conn.getMultipleAccountsInfoAndContext(chunks[i], opts.commitment ?? "confirmed");
          results[i] = { infos: r.value, slot: r.context.slot };
        } catch (e: any) {
          results[i] = e instanceof Error ? e : new Error(String(e));
        }
      }
    }),
  );

  const byKey: (AccountInfo<Buffer> | null | undefined)[] = new Array(unique.length);
  let slot = Infinity;
  const failedUnique = new Set<number>();
  results.forEach((r, c) => {
    if (r instanceof Error) {
      if (!opts.partial) throw r;
      for (let j = 0; j < chunks[c].length; j++) failedUnique.add(c * size + j);
      return;
    }
    slot = Math.min(slot, r.slot);
    r.infos.forEach((info, j) => (byKey[c * size + j] = info));
  });
  const infos = keys.map((k) => byKey[at.get(k.toBase58())!]);
  const failed = keys.flatMap((k, i) => (failedUnique.has(at.get(k.toBase58())!) ? [i] : []));
  return { infos, slot: isFinite(slot) ? slot : 0, failed };
}

/** Plain list of accounts in the order asked (throws if any chunk fails). */
export async function getAccounts(conn: Connection, keys: PublicKey[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]> {
  if (!keys.length) return [];
  return (await loadAccounts(conn, keys, { commitment })).infos as (AccountInfo<Buffer> | null)[];
}
