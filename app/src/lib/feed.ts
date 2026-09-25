"use client";

import { EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { MANDATE_PROGRAM_ID } from "../../../sdk/src";
import { connection, readClient } from "./chain";

/**
 * The network's activity, read from the program's own events (Anchor `emit!` logs) in
 * recent transactions. Each address keeps an incremental cache: later polls only fetch
 * transactions newer than the last one seen.
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
}

interface Cache {
  events: FeedEvent[];
  /** Newest signature below which everything has been read. */
  newest?: string;
  seen: Set<string>;
}
const caches = new Map<string, Cache>();
const MAX_EVENTS = 150;

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

export async function loadFeed(address: PublicKey = MANDATE_PROGRAM_ID, limit = 30): Promise<FeedEvent[]> {
  const id = address.toBase58();
  const cache = caches.get(id) ?? { events: [], seen: new Set<string>() };
  const conn = connection();
  const all = await conn.getSignaturesForAddress(address, { limit, until: cache.newest }, "confirmed");
  const sigs = all.filter((s) => !s.err && !cache.seen.has(s.signature));
  if (sigs.length) {
    const txs = await mapLimit(sigs, 3, (s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => undefined));
    const fresh: FeedEvent[] = [];
    sigs.forEach((s, i) => {
      const tx = txs[i];
      if (tx === undefined) return; // failed to load (e.g. rate limited): retried on the next poll
      cache.seen.add(s.signature);
      if (!tx?.meta?.logMessages) return;
      const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58() ?? "";
      let j = 0;
      for (const ev of eventParser().parseLogs(tx.meta.logMessages)) {
        const mandate = ev.data?.mandate?.toBase58?.() ?? "";
        fresh.push({ key: `${s.signature}:${j++}`, sig: s.signature, slot: s.slot, ts: tx.blockTime ?? s.blockTime ?? 0, name: ev.name, data: ev.data, mandate, signer });
      }
    });
    // Newest first; events within one transaction keep their emitted order reversed with it.
    fresh.sort((a, b) => b.slot - a.slot || (a.sig === b.sig ? b.key.localeCompare(a.key) : 0));
    cache.events = [...fresh, ...cache.events].sort((a, b) => b.slot - a.slot).slice(0, MAX_EVENTS);
  }
  // Only move the high-water mark once every transaction up to it has been read.
  if (all.length && sigs.every((s) => cache.seen.has(s.signature))) cache.newest = all[0].signature;
  caches.set(id, cache);
  return cache.events;
}
