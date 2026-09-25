import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import {
  ata,
  createDlmmPair,
  createMint,
  dlmmSwap,
  fundedKeypair,
  initBinArrays,
  mandateProgram,
  mintTo,
  ONE_Q64,
  Pair,
  send,
  sendExpectFail,
  startSvm,
  tokenBalance,
  warp,
  writeReferencePool,
} from "./helpers";
import { MandateClient, MandateTerms, pda, decodeLbPair, statusName } from "../sdk/src";

const U = (n: number) => new BN(Math.round(n * 1e6));

const TERMS: MandateTerms = {
  feePerPeriod: U(2),
  periodSecs: 600,
  durationPeriods: 3,
  bondAmount: U(50),
  maxSpreadBps: 100,
  minDepthQuote: U(100),
  depthWindowBps: 200,
  bandBps: 500,
  anchorTwapSecs: 300,
  anchorSpeedBpsPerMin: 100,
  liquidityLockSecs: 30,
  maxConsecutiveFailures: 2,
  slashBps: 10_000,
};

describe("mandate lifecycle", () => {
  let svm: LiteSVM;
  let client: MandateClient;
  let issuer: Keypair, maker: Keypair, cranker: Keypair, mintAuth: Keypair;
  let base: PublicKey, quote: PublicKey;
  let pair: Pair;
  const refPool = Keypair.generate().publicKey;

  const load = (k: PublicKey) => client.decodeMandate(svm.getAccount(k)!.data);
  const lb = () => decodeLbPair(svm.getAccount(pair.lbPair)!.data);

  async function newMandate(id: number, terms = TERMS): Promise<PublicKey> {
    const key = pda.mandate(issuer.publicKey, base, id);
    send(svm, issuer, [
      await client.createMandate({
        issuer: issuer.publicKey,
        baseMint: base,
        quoteMint: quote,
        lbPair: pair.lbPair,
        referencePool: refPool,
        id,
        terms,
        baseDeposit: U(5_000),
        quoteDeposit: U(5_000),
        feeBudget: U(6),
      }),
    ]);
    return key;
  }

  async function acceptAndQuote(key: PublicKey, lower = -35) {
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
    send(svm, maker, [await client.openPosition({ maker: maker.publicKey, mandate: key, m: load(key), lowerBinId: lower, width: 70 })]);
    send(svm, maker, [
      await client.addLiquidity({
        authority: maker.publicKey,
        mandate: key,
        m: load(key),
        pair: lb(),
        amountBase: U(1_000),
        amountQuote: U(1_000),
        minBinId: -6,
        maxBinId: 6,
      }),
    ]);
  }

  before(() => {
    svm = startSvm();
    client = new MandateClient(mandateProgram());
    issuer = fundedKeypair(svm);
    maker = fundedKeypair(svm);
    cranker = fundedKeypair(svm);
    mintAuth = fundedKeypair(svm);
    base = createMint(svm, mintAuth, 6);
    quote = createMint(svm, mintAuth, 6);
    mintTo(svm, mintAuth, base, issuer.publicKey, 1_000_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, issuer.publicKey, 1_000_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, maker.publicKey, 10_000n * 1_000_000n);
    pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
    initBinArrays(svm, issuer, pair.lbPair, [-1, 0]);
    writeReferencePool(svm, refPool, base, quote, ONE_Q64);
  });

  it("issuer can cancel an unaccepted mandate and gets everything back", async () => {
    const key = await newMandate(10);
    const ib = tokenBalance(svm, ata(base, issuer.publicKey));
    const iq = tokenBalance(svm, ata(quote, issuer.publicKey));
    send(svm, issuer, [await client.cancel({ mandate: key, m: load(key) })]);
    expect(statusName(load(key).status)).to.eq("Cancelled");
    expect(tokenBalance(svm, ata(base, issuer.publicKey)) - ib).to.eq(5_000_000_000n);
    expect(tokenBalance(svm, ata(quote, issuer.publicKey)) - iq).to.eq(5_006_000_000n);
    // A maker can no longer accept it.
    const logs = sendExpectFail(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("InvalidStatus");
  });

  it("a designated maker restriction is enforced", async () => {
    const other = fundedKeypair(svm);
    mintTo(svm, mintAuth, quote, other.publicKey, 1_000n * 1_000_000n);
    const key = pda.mandate(issuer.publicKey, base, 11);
    send(svm, issuer, [
      await client.createMandate({
        issuer: issuer.publicKey,
        baseMint: base,
        quoteMint: quote,
        lbPair: pair.lbPair,
        referencePool: refPool,
        id: 11,
        terms: TERMS,
        baseDeposit: U(10),
        quoteDeposit: U(10),
        feeBudget: U(0),
        designatedMaker: maker.publicKey,
      }),
    ]);
    const logs = sendExpectFail(svm, other, [await client.accept({ maker: other.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("Unauthorized");
  });

  it("liquidity cannot be pulled right after it is added (anti snapshot-sandwich)", async () => {
    const key = await newMandate(12);
    await acceptAndQuote(key);
    const logs = sendExpectFail(svm, maker, [
      await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb() }),
    ]);
    expect(logs.join("\n")).to.contain("LiquidityCooldown");
    warp(svm, 31);
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb(), bps: 1_000 })]);
  });

  it("a position with unclaimed LP fees can still be unwound (claim-only step)", async () => {
    const key = await newMandate(15);
    await acceptAndQuote(key);
    const trader = fundedKeypair(svm);
    mintTo(svm, mintAuth, quote, trader.publicKey, 1_000n * 1_000_000n);
    dlmmSwap(svm, trader, pair, 200_000_000n, false, [0, 1]); // generates LP fees
    warp(svm, 31);
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb(), claimFees: false })]);
    const logs = sendExpectFail(svm, maker, [await client.closePosition({ authority: maker.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("NonEmptyPosition");
    const vaultQuote = tokenBalance(svm, load(key).quoteVault);
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb(), bps: 0, claimFees: true })]);
    expect(tokenBalance(svm, load(key).quoteVault) > vaultQuote, "fees land in the vault").to.eq(true);
    send(svm, maker, [await client.closePosition({ authority: maker.publicKey, mandate: key, m: load(key) })]);
  });

  it("a fully compliant term expires normally; bond and fees go to the maker", async () => {
    const key = await newMandate(13);
    await acceptAndQuote(key, -30);
    for (let p = 0; p < 3; p++) {
      warp(svm, 60);
      send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: key, m: load(key) })]);
      expect(load(key).last.ok).to.eq(true);
      warp(svm, 540);
    }
    send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
    let s = load(key);
    expect(statusName(s.status)).to.eq("Expired");
    expect(s.periodsOk).to.eq(3);
    expect(s.feesEarned.toNumber()).to.eq(6_000_000);

    // Anyone unwinds after expiry.
    send(svm, cranker, [await client.removeLiquidity({ authority: cranker.publicKey, mandate: key, m: s, pair: lb() })]);
    send(svm, cranker, [await client.closePosition({ authority: cranker.publicKey, mandate: key, m: load(key) })]);

    const mq = tokenBalance(svm, ata(quote, maker.publicKey));
    s = load(key);
    send(svm, cranker, [await client.settle({ mandate: key, m: s })]);
    expect(statusName(load(key).status)).to.eq("Settled");
    // 3 × 2 USDC fees + full 50 USDC bond back
    expect(tokenBalance(svm, ata(quote, maker.publicKey)) - mq).to.eq(56_000_000n);
    const profile = client.decodeMakerProfile(svm.getAccount(pda.makerProfile(maker.publicKey))!.data);
    expect(profile.mandatesCompleted).to.eq(1);
  });

  it("unobserved periods are neither paid nor failed, and long gaps finalize in bounded chunks", async () => {
    const terms = { ...TERMS, periodSecs: 60, durationPeriods: 100, maxConsecutiveFailures: 5 };
    const key = await newMandate(14, terms);
    await acceptAndQuote(key, -30);
    warp(svm, 60 * 80); // 80 periods with no snapshots
    send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
    let s = load(key);
    expect(s.currentPeriod).to.eq(32); // capped per call
    send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
    send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
    s = load(key);
    expect(s.currentPeriod).to.eq(80);
    expect(s.periodsUnobserved).to.eq(80);
    expect(s.periodsOk).to.eq(0);
    expect(s.consecutiveFailed).to.eq(0);
    expect(statusName(s.status)).to.eq("Active");
  });
});
