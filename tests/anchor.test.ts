import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import {
  createDlmmPair,
  createMint,
  dlmmGoToBin,
  dlmmSwap,
  fundedKeypair,
  initBinArrays,
  mandateProgram,
  mintTo,
  now,
  ONE_Q64,
  oracleCumulative,
  Pair,
  readActiveId,
  send,
  startSvm,
  warp,
  writeReferencePool,
} from "./helpers";
import { MandateClient, MandateTerms, pda, decodeLbPair, anchorState, projectAnchor, decodeOracleLatest } from "../sdk/src";

const U = (n: number) => new BN(Math.round(n * 1e6));

// bin_step 25 and 100 bps/min: the reference moves at most 4 bins a minute.
const TERMS: MandateTerms = {
  feePerPeriod: U(1),
  periodSecs: 3600,
  durationPeriods: 24,
  bondAmount: U(100),
  maxSpreadBps: 100,
  minDepthQuote: U(100),
  depthWindowBps: 200,
  bandBps: 500,
  anchorTwapSecs: 300,
  anchorSpeedBpsPerMin: 100,
  liquidityLockSecs: 10,
  maxConsecutiveFailures: 3,
  slashBps: 10_000,
};

describe("reference price (DLMM oracle TWAP, speed-limited)", () => {
  let svm: LiteSVM;
  let client: MandateClient;
  let issuer: Keypair, maker: Keypair, trader: Keypair;
  let base: PublicKey, quote: PublicKey;
  let pair: Pair;
  let mandate: PublicKey;
  const referencePool = Keypair.generate().publicKey;

  const m = () => client.decodeMandate(svm.getAccount(mandate)!.data);
  const lb = () => decodeLbPair(svm.getAccount(pair.lbPair)!.data);
  const snapshot = async () => send(svm, trader, [await client.snapshot({ cranker: trader.publicKey, mandate, m: m() })]);
  const nudge = () => dlmmSwap(svm, trader, pair, 1_000n, false, [0, 1]); // records an oracle sample
  const predicted = () =>
    projectAnchor(anchorState(m()), decodeOracleLatest(svm.getAccount(pair.oracle)!.data), TERMS, 25, Number(now(svm)));

  before(async () => {
    svm = startSvm();
    client = new MandateClient(mandateProgram());
    issuer = fundedKeypair(svm);
    maker = fundedKeypair(svm);
    trader = fundedKeypair(svm);
    const auth = fundedKeypair(svm);
    base = createMint(svm, auth, 6);
    quote = createMint(svm, auth, 6);
    mintTo(svm, auth, base, issuer.publicKey, 10n ** 12n);
    mintTo(svm, auth, quote, issuer.publicKey, 10n ** 12n);
    mintTo(svm, auth, quote, maker.publicKey, 10n ** 10n);
    mintTo(svm, auth, base, trader.publicKey, 10n ** 11n);
    mintTo(svm, auth, quote, trader.publicKey, 10n ** 11n);
    pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
    initBinArrays(svm, issuer, pair.lbPair, [-1, 0, 1, 2, 3]);
    writeReferencePool(svm, referencePool, base, quote, ONE_Q64);

    mandate = pda.mandate(issuer.publicKey, base, 1);
    send(svm, issuer, [
      await client.createMandate({
        issuer: issuer.publicKey, baseMint: base, quoteMint: quote, lbPair: pair.lbPair, referencePool, id: 1, terms: TERMS,
        baseDeposit: U(5_000), quoteDeposit: U(5_000), feeBudget: U(24),
      }),
    ]);
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate, m: m() })]);
    send(svm, maker, [await client.openPosition({ maker: maker.publicKey, mandate, m: m(), lowerBinId: -35, width: 70 })]);
    send(svm, maker, [
      await client.addLiquidity({ authority: maker.publicKey, mandate, m: m(), pair: lb(), amountBase: U(1_300), amountQuote: U(1_300), minBinId: -12, maxBinId: 12 }),
    ]);
    // Establish a TWAP window at bin 0.
    nudge();
    warp(svm, 400);
    nudge();
    await snapshot();
    expect(m().anchor.bin).to.eq(0);
    expect(m().anchor.target).to.eq(0);
  });

  it("a price spike inside one transaction does not move the reference", async () => {
    dlmmSwap(svm, trader, pair, 900_000_000n, false, [0, 1]); // buy through the asks
    const spiked = readActiveId(svm, pair.lbPair);
    expect(spiked).to.be.gte(5);
    await snapshot();
    expect(m().anchor.bin).to.eq(0);
    expect(m().anchor.target).to.eq(0, "no time passed at the spiked price");
    // Sell back down.
    for (let i = 0; i < 20 && readActiveId(svm, pair.lbPair) > 0; i++) dlmmSwap(svm, trader, pair, 100_000_000n, true, [0, -1]);
    expect(readActiveId(svm, pair.lbPair)).to.be.lte(0);
  });

  it("a sustained move pulls the reference along at a bounded speed", async () => {
    for (let i = 0; i < 20 && readActiveId(svm, pair.lbPair) < 6; i++) dlmmSwap(svm, trader, pair, 100_000_000n, false, [0, 1]);
    const held = readActiveId(svm, pair.lbPair);
    warp(svm, 600);
    nudge();
    const expected = predicted();
    await snapshot();
    let a = m().anchor;
    expect(a.target).to.be.within(held - 1, held);
    expect(a.bin).to.eq(4, "capped at one minute's worth (4 bins) per refresh");
    expect(a.bin).to.eq(expected.bin, "the SDK predicts the on-chain reference");
    warp(svm, 15);
    await snapshot();
    expect(m().anchor.bin).to.eq(5, "then 4 bins per minute: one bin per 15 s");
  });

  it("an emptied active bin taints the oracle, so go_to_a_bin cannot drag the reference", async () => {
    const before = m().anchor;
    warp(svm, 600); // the market goes quiet
    const active = readActiveId(svm, pair.lbPair);
    const o0 = oracleCumulative(svm, pair.oracle);

    // The maker pulls the vault's liquidity from the active bin upward, leaving the active
    // bin empty, then anyone jumps the active bin across the empty range...
    send(svm, maker, [
      await client.removeLiquidity({ authority: maker.publicKey, mandate, m: m(), pair: lb(), fromBinId: active, toBinId: 34, claimFees: false }),
    ]);
    expect(Number(m().anchor.taintTs)).to.eq(Number(now(svm)));
    dlmmGoToBin(svm, trader, pair.lbPair, 200, 0, 2);
    expect(readActiveId(svm, pair.lbPair)).to.eq(200);
    // ...and the next swap credits bin 200 for the whole quiet period.
    dlmmSwap(svm, trader, pair, 1_000n, true, [2, 1, 0]);
    const o1 = oracleCumulative(svm, pair.oracle);
    const misattributed = Number(o1.cumulative - o0.cumulative) / (o1.ts - o0.ts);
    expect(misattributed).to.be.gt(150, "DLMM's own TWAP is now wrong");

    await snapshot();
    expect(m().anchor.bin).to.eq(before.bin, "the reference ignores the tainted samples");

    // A fresh window after the taint tracks the real price again.
    const real = readActiveId(svm, pair.lbPair);
    warp(svm, 300);
    nudge();
    await snapshot();
    expect(m().anchor.target).to.be.within(real - 1, real + 1);
    expect(Math.abs(m().anchor.bin - before.bin)).to.be.lte(4);
  });
});
