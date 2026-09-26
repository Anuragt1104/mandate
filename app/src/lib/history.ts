"use client";

import { EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { MANDATE_PROGRAM_ID } from "../../../sdk/src";
import { connection, readClient } from "./chain";

/**
 * An agreement's opening and closing facts from its own transaction history: what the team
 * deposited (and leftover routed in), where the reference stood at the first check, and how
 * settlement split the money. The newest and oldest transactions are read; the middle (every
 * check) is not needed. `complete` says whether the oldest transaction was reached.
 */
export interface History {
  created: { ts: number; baseDeposit: bigint; quoteDeposit: bigint; feeBudget: bigint } | null;
  routed: bigint;
  firstCheck: { ts: number; anchorBin: number } | null;
  slashed: { ts: number; amount: bigint; sig: string } | null;
  settled: { ts: number; toIssuerBase: bigint; toIssuerQuote: bigint; toMakerQuote: bigint; sig: string } | null;
  complete: boolean;
}

const big = (v: any) => BigInt(v?.toString?.() ?? v ?? 0);

/** The opening facts never change: read them once per agreement. */
const opening = new Map<string, Pick<History, "created" | "routed" | "firstCheck">>();

export async function loadHistory(mandate: PublicKey): Promise<History> {
  const conn = connection();
  const parser = new EventParser(MANDATE_PROGRAM_ID, readClient().program.coder);
  const id = mandate.toBase58();
  const known = opening.get(id);
  // Page back (100 at a time, the proxy's bound) to the oldest transaction, unless the opening is cached.
  const sigs: { signature: string; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  let complete = false;
  for (let page = 0; page < (known ? 1 : 80); page++) {
    const batch = await conn.getSignaturesForAddress(mandate, { limit: 100, before }, "confirmed");
    sigs.push(...batch);
    if (batch.length < 100) {
      complete = true;
      break;
    }
    before = batch[batch.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err);
  const h: History = { created: known?.created ?? null, routed: known?.routed ?? 0n, firstCheck: known?.firstCheck ?? null, slashed: null, settled: null, complete: !!known || complete };
  const read = async (list: typeof ok, part: "opening" | "closing") => {
    for (const s of list) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      if (!tx?.meta?.logMessages) continue;
      const ts = tx.blockTime ?? s.blockTime ?? 0;
      for (const ev of parser.parseLogs(tx.meta.logMessages)) {
        const d = ev.data as any;
        if (d?.mandate?.toBase58?.() !== id) continue;
        if (part === "opening") {
          if (ev.name === "mandateCreated") h.created = { ts, baseDeposit: big(d.baseDeposit), quoteDeposit: big(d.quoteDeposit), feeBudget: big(d.feeBudget) };
          else if (ev.name === "leftoverRouted") h.routed += big(d.amount);
          else if (ev.name === "snapshotTaken" && !h.firstCheck) h.firstCheck = { ts, anchorBin: Number(d.anchorBin) };
        }
        if (ev.name === "makerSlashed") h.slashed = { ts, amount: big(d.amount), sig: s.signature };
        else if (ev.name === "mandateSettled") h.settled = { ts, toIssuerBase: big(d.toIssuerBase), toIssuerQuote: big(d.toIssuerQuote), toMakerQuote: big(d.toMakerQuote), sig: s.signature };
      }
    }
  };
  if (!known && complete) {
    await read(ok.slice(-12).reverse(), "opening");
    opening.set(id, { created: h.created, routed: h.routed, firstCheck: h.firstCheck });
  }
  await read(ok.slice(0, 12), "closing");
  return h;
}
