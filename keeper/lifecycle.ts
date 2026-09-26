/**
 * The lifecycle steps every keeper runs, in one place: close out elapsed periods, unwind an
 * ended mandate's position and settle it. Each step re-reads the mandate and only continues
 * while its state still calls for it, so competing keepers (or a breach part-way through)
 * converge instead of failing: finalize is a no-op on an ended mandate, and every send here
 * is idempotent.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MandateClient, decodeLbPair, statusName } from "../sdk/src";
import { fetchMandate, sendIxs } from "./common";

/** Periods that have fully elapsed at `now` but are not finalized yet. */
export function periodsBehind(m: any, now: number): number {
  const period = m.terms.periodSecs as number;
  const start = m.startTs.toNumber();
  if (now <= start) return 0;
  return Math.max(0, Math.min(m.terms.durationPeriods, Math.floor((now - start) / period)) - m.currentPeriod);
}

/**
 * Finalize one call at a time (each closes up to 32 periods), re-reading in between, until
 * the backlog is gone, the mandate ends, or `maxCalls` is spent. Returns the latest state.
 */
export async function catchUp(conn: Connection, me: Keypair, client: MandateClient, key: PublicKey, m: any, now: number, maxCalls = 8): Promise<{ m: any; calls: number }> {
  let calls = 0;
  while (calls < maxCalls && statusName(m.status) === "Active" && periodsBehind(m, now) > 0) {
    await sendIxs(conn, me, [await client.finalize({ mandate: key, m })], [], { idempotent: true, deadlineMs: 45_000 });
    calls++;
    m = await fetchMandate(conn, client, key);
  }
  return { m, calls };
}

/** Unwind the position of a breached or expired mandate, then settle it. Returns what it did. */
export async function closeOut(conn: Connection, me: Keypair, client: MandateClient, key: PublicKey, m: any): Promise<string | null> {
  const status = statusName(m.status);
  if (status !== "Breached" && status !== "Expired") return null;
  if (!(m.position as PublicKey).equals(PublicKey.default)) {
    const info = await conn.getAccountInfo(m.lbPair);
    if (!info) throw new Error("the mandate's DLMM pair was not found");
    const pair = decodeLbPair(info.data);
    await sendIxs(
      conn,
      me,
      [await client.removeLiquidity({ authority: me.publicKey, mandate: key, m, pair }), await client.closePosition({ authority: me.publicKey, mandate: key, m })],
      [],
      { idempotent: true, deadlineMs: 60_000 },
    );
    return `unwound the ${status.toLowerCase()} mandate`;
  }
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  await sendIxs(
    conn,
    me,
    [
      createAssociatedTokenAccountIdempotentInstruction(me.publicKey, ata(m.baseMint, m.issuer), m.issuer, m.baseMint),
      createAssociatedTokenAccountIdempotentInstruction(me.publicKey, ata(m.quoteMint, m.issuer), m.issuer, m.quoteMint),
      createAssociatedTokenAccountIdempotentInstruction(me.publicKey, ata(m.quoteMint, m.maker), m.maker, m.quoteMint),
      await client.settle({ mandate: key, m }),
    ],
    [],
    { idempotent: true, deadlineMs: 60_000 },
  );
  return `settled the ${status.toLowerCase()} mandate`;
}

/** Run `fn` over `items` with at most `limit` in flight; each item's failure is its own. */
export async function eachLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item).catch(() => undefined);
      }
    }),
  );
}
