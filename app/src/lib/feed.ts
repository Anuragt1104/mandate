"use client";

import { EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { MANDATE_PROGRAM_ID } from "../../../sdk/src";
import { sentinelReadsFromTx, type VerifiedRead } from "../../../sdk/src/sentinel";
import { connection, readClient } from "./chain";

/**
 * The network's activity, read from the program's own events (Anchor `emit!` logs) in
 * recent transactions. Each address keeps an incremental cache:
 *   - later polls page back from the newest signature to the saved cursor (up to a limit),
 *     so a burst of activity between polls isn't silently skipped;
 *   - a transaction that isn't available yet (null at this commitment, or a failed read)
 *     is kept and retried, not marked as read;
 *   - `feedStatus()` says when the history has a gap, so the page doesn't imply it's complete.
 */
export interface FeedEvent {
  key: string;
  sig: string;
  slot: number;
  ts: number;
  name: string;
  data: any;
  mandate: string;
  signer: string;
  /** A watchtower read published with this check, about this same mandate (checks only). */
  read: VerifiedRead | null;
}

interface Cache {
  events: FeedEvent[];
  /** Newest signature at or below which everything was read or is pending. */
  cursor?: string;
  seen: Set<string>;
  pending: Map<string, { slot: number; blockTime: number | null; tries: number }>;
  /** True once some history couldn't be paged in (too much activity between polls) or was given up on. */
  gap: boolean;
}
const caches = new Map<string, Cache>();
const MAX_EVENTS = 150;
const MAX_PAGES = 4;
const MAX_TRIES = 12;

let parser: EventParser | null = null;
function eventParser() {
  parser ??= new EventParser(MANDATE_PROGRAM_ID, readClient().program.coder);
  return parser;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Whether the cached history for `address` has a known gap, and how many transactions are still loading. */
export function feedStatus(address: PublicKey = MANDATE_PROGRAM_ID) {
  const c = caches.get(address.toBase58());
  return { pending: c?.pending.size ?? 0, gap: c?.gap ?? false };
}

export async function loadFeed(address: PublicKey = MANDATE_PROGRAM_ID, limit = 30): Promise<FeedEvent[]> {
  const id = address.toBase58();
  const cache: Cache = caches.get(id) ?? { events: [], seen: new Set<string>(), pending: new Map(), gap: false };
  const conn = connection();

  // Page back from the newest signature to the cursor. The first load takes one page.
  const listed: { signature: string; slot: number; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  let reached = false;
  for (let page = 0; page < (cache.cursor ? MAX_PAGES : 1); page++) {
    const sigs = await conn.getSignaturesForAddress(address, { limit, before, until: cache.cursor }, "confirmed");
    listed.push(...sigs);
    if (sigs.length < limit) {
      reached = true;
      break;
    }
    before = sigs[sigs.length - 1].signature;
  }
  if (cache.cursor && !reached) cache.gap = true;
  for (const s of listed) {
    if (!s.err && !cache.seen.has(s.signature) && !cache.pending.has(s.signature)) cache.pending.set(s.signature, { slot: s.slot, blockTime: s.blockTime ?? null, tries: 0 });
  }
  if (listed.length) cache.cursor = listed[0].signature;

  const todo = [...cache.pending.entries()].slice(0, 60);
  const txs = await mapLimit(todo, 3, ([sig]) => conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => undefined));
  const fresh: FeedEvent[] = [];
  todo.forEach(([sig, p], i) => {
    const tx = txs[i];
    if (!tx) {
      // null: not available yet at this commitment; undefined: the read failed. Retry later.
      if (++p.tries > MAX_TRIES) {
        cache.pending.delete(sig);
        cache.gap = true;
      }
      return;
    }
    cache.pending.delete(sig);
    cache.seen.add(sig);
    if (tx.meta?.err || !tx.meta?.logMessages) return;
    const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58() ?? "";
    const reads = sentinelReadsFromTx(tx as any);
    let j = 0;
    for (const ev of eventParser().parseLogs(tx.meta.logMessages)) {
      const mandate = ev.data?.mandate?.toBase58?.() ?? "";
      // A read counts only for the check on the mandate it names.
      const read = ev.name === "snapshotTaken" ? reads.find((r) => r.read.mandate === mandate) ?? null : null;
      fresh.push({ key: `${sig}:${j++}`, sig, slot: tx.slot ?? p.slot, ts: tx.blockTime ?? p.blockTime ?? 0, name: ev.name, data: ev.data, mandate, signer, read });
    }
  });
  if (fresh.length) {
    // Newest first; events within one transaction keep their emitted order reversed with it.
    const order = (a: FeedEvent, b: FeedEvent) => b.slot - a.slot || (a.sig === b.sig ? b.key.localeCompare(a.key) : 0);
    cache.events = [...fresh, ...cache.events].sort(order).slice(0, MAX_EVENTS);
  }
  if (cache.seen.size > 2_000) cache.seen = new Set([...cache.seen].slice(-1_000));
  caches.set(id, cache);
  return cache.events;
}
