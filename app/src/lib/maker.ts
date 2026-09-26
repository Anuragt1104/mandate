"use client";

import { BN } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MandateClient, StrategyType, binArrayIndex, dlmmInitBinArrayIx } from "../../../sdk/src";
import { connection } from "./chain";
import type { MandateView } from "./loaders";

/**
 * The operator's actions on an agreement, as instruction builders shared by the work queue:
 * each builds from the agreement's state, can be simulated without a signature, and is only
 * sent after the operator approves it in their wallet.
 */
export type ActionKind = "accept" | "open" | "deploy" | "recentre" | "finalize" | "claim" | "unwind" | "settle";

export interface ProposedAction {
  kind: ActionKind;
  title: string;
  why: string;
}

export async function buildAction(c: MandateClient, me: PublicKey, v: MandateView, kind: ActionKind, m: any = v.m): Promise<TransactionInstruction[]> {
  const key = v.key;
  const book = v.book;
  switch (kind) {
    case "accept":
      return [createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, me, true), me, m.quoteMint), await c.accept({ maker: me, mandate: key, m })];
    case "open": {
      if (!book) throw new Error("The pair couldn't be read.");
      const lower = book.refBin - 35;
      const ixs = [];
      for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + 69); i++) ixs.push(dlmmInitBinArrayIx(m.lbPair, i, me));
      const infos = await connection().getMultipleAccountsInfo(ixs.map((ix) => ix.keys[1].pubkey));
      return [...ixs.filter((_, i) => !infos[i]), await c.openPosition({ maker: me, mandate: key, m, lowerBinId: lower, width: 70 })];
    }
    case "deploy": {
      if (!book) throw new Error("The pair couldn't be read.");
      const pair = book.pair;
      const ref = book.refBin;
      const t = m.terms;
      const bandBins = Math.floor(Math.log(1 + t.bandBps / 10_000) / Math.log(1 + pair.binStep / 10_000)) - 1;
      const lower = m.positionLowerBinId as number;
      const upper = lower + (m.positionWidth as number) - 1;
      const half = 8;
      const lo = Math.max(ref - Math.min(half, bandBins), lower);
      const hi = Math.min(ref + Math.min(half, bandBins), upper);
      const [baseIdle, quoteIdle] = v.balances;
      const ixs = [];
      const bidMax = Math.min(ref + 1, pair.activeId, hi);
      if (quoteIdle > 0n && lo <= bidMax)
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(0), amountQuote: new BN(((quoteIdle * 9n) / 10n).toString()), minBinId: lo, maxBinId: bidMax, strategy: StrategyType.SpotImBalanced }));
      const askMin = Math.max(ref, pair.activeId, lo);
      if (baseIdle > 0n && askMin <= hi)
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(((baseIdle * 9n) / 10n).toString()), amountQuote: new BN(0), minBinId: askMin, maxBinId: hi, strategy: StrategyType.SpotImBalanced }));
      if (!ixs.length) throw new Error("Nothing to place: the vault is empty or no bins are allowed right now.");
      return ixs;
    }
    case "recentre":
    case "unwind":
      if (!book) throw new Error("The pair couldn't be read.");
      return [await c.removeLiquidity({ authority: me, mandate: key, m, pair: book.pair }), await c.closePosition({ authority: me, mandate: key, m })];
    case "finalize":
      return [await c.finalize({ mandate: key, m })];
    case "claim":
      return [await c.claimMakerFees({ mandate: key, m })];
    case "settle":
      return [
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.baseMint, m.issuer, true), m.issuer, m.baseMint),
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.issuer, true), m.issuer, m.quoteMint),
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.maker, true), m.maker, m.quoteMint),
        await c.settle({ mandate: key, m }),
      ];
  }
}

export interface Simulation {
  ok: boolean;
  error: string | null;
  units: number | null;
  logs: string[];
}

/** Simulate without a signature (the wallet is only asked when the operator approves). */
export async function simulate(me: PublicKey, ixs: TransactionInstruction[]): Promise<Simulation> {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: me, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const logs = r.value.logs ?? [];
  const anchorMsg = logs.map((l) => l.match(/Error Message: ([^.]+)/)?.[1]).find(Boolean);
  return { ok: !r.value.err, error: r.value.err ? anchorMsg ?? JSON.stringify(r.value.err) : null, units: r.value.unitsConsumed ?? null, logs };
}
