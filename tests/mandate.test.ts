import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import {
  ata,
  createDlmmPair,
  createMint,
  dlmmSwap,
  ensureAta,
  fundedKeypair,
  initBinArrays,
  mandateProgram,
  mintTo,
  ONE_Q64,
  Pair,
  readActiveId,
  send,
  sendExpectFail,
  startSvm,
  tokenBalance,
  warp,
  writeReferencePool,
} from "./helpers";
import { MandateClient, MandateTerms, pda, decodeLbPair, statusName, StrategyType } from "../sdk/src";

const USDC = (n: number) => new BN(Math.round(n * 1e6));

const TERMS: MandateTerms = {
  feePerPeriod: USDC(1),
  periodSecs: 3600,
  durationPeriods: 24,
  bondAmount: USDC(100),
  maxSpreadBps: 100,
  minDepthQuote: USDC(500),
  depthWindowBps: 200,
  bandBps: 500,
  maxRefDeviationBps: 100,
  minSnapshotIntervalSecs: 10,
  maxConsecutiveFailures: 3,
  slashBps: 5_000,
};

describe("mandate (LiteSVM + mainnet Meteora DLMM)", () => {
  let svm: LiteSVM;
  let client: MandateClient;
  let issuer: Keypair, maker: Keypair, trader: Keypair, cranker: Keypair;
  let base: PublicKey, quote: PublicKey;
  let pair: Pair;
  const referencePool = Keypair.generate().publicKey;
  let mandate: PublicKey;

  const m = () => client.decodeMandate(svm.getAccount(mandate)!.data);
  const lb = () => decodeLbPair(svm.getAccount(pair.lbPair)!.data);

  before(() => {
    svm = startSvm();
    client = new MandateClient(mandateProgram());
    issuer = fundedKeypair(svm);
    maker = fundedKeypair(svm);
    trader = fundedKeypair(svm);
    cranker = fundedKeypair(svm);

    const mintAuth = fundedKeypair(svm);
    base = createMint(svm, mintAuth, 6);
    quote = createMint(svm, mintAuth, 6);
    mintTo(svm, mintAuth, base, issuer.publicKey, 1_000_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, issuer.publicKey, 1_000_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, maker.publicKey, 1_000n * 1_000_000n);
    mintTo(svm, mintAuth, base, trader.publicKey, 100_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, trader.publicKey, 100_000n * 1_000_000n);

    // DLMM pair, base = X, quote = Y, bin_step 25 (0.25%), active bin 0 => price 1.0
    pair = createDlmmPair(svm, issuer, base, quote, 25, 0);
    initBinArrays(svm, issuer, pair.lbPair, [-1, 0]);
    // Reference pool (graduated DAMM v2) at the same price.
    writeReferencePool(svm, referencePool, base, quote, ONE_Q64);
  });

  it("rejects a DLMM pair whose token X is not the base mint", async () => {
    const ix = await client.createMandate({
      issuer: issuer.publicKey,
      baseMint: quote,
      quoteMint: base,
      lbPair: pair.lbPair,
      referencePool,
      id: 99,
      terms: TERMS,
      baseDeposit: new BN(0),
      quoteDeposit: new BN(0),
      feeBudget: new BN(0),
    });
    const logs = sendExpectFail(svm, issuer, [ix]);
    expect(logs.join("\n")).to.contain("PairMintMismatch");
  });

  it("issuer creates and funds a mandate", async () => {
    mandate = pda.mandate(issuer.publicKey, base, 1);
    const ix = await client.createMandate({
      issuer: issuer.publicKey,
      baseMint: base,
      quoteMint: quote,
      lbPair: pair.lbPair,
      referencePool,
      id: 1,
      terms: TERMS,
      baseDeposit: USDC(20_000),
      quoteDeposit: USDC(20_000),
      feeBudget: USDC(24),
    });
    send(svm, issuer, [ix]);
    const s = m();
    expect(statusName(s.status)).to.eq("Open");
    expect(tokenBalance(svm, s.baseVault)).to.eq(20_000_000_000n);
    expect(tokenBalance(svm, s.quoteVault)).to.eq(20_000_000_000n);
    expect(tokenBalance(svm, s.feeVault)).to.eq(24_000_000n);
  });

  it("maker accepts and posts the bond", async () => {
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate, m: m() })]);
    const s = m();
    expect(statusName(s.status)).to.eq("Active");
    expect(s.maker.toBase58()).to.eq(maker.publicKey.toBase58());
    expect(tokenBalance(svm, s.bondVault)).to.eq(100_000_000n);
  });

  it("maker opens a DLMM position owned by the mandate PDA", async () => {
    send(svm, maker, [await client.openPosition({ maker: maker.publicKey, mandate, m: m(), lowerBinId: -35, width: 70 })]);
    const s = m();
    expect(s.position.toBase58()).to.eq(pda.dlmmPosition(pair.lbPair, mandate, -35, 70).toBase58());
  });

  it("blocks liquidity placed outside the reference band", async () => {
    // band 5% @ bin_step 0.25% ≈ ±20 bins; bin -35 is ~8.4% below reference.
    const ix = await client.addLiquidity({
      authority: maker.publicKey,
      mandate,
      m: m(),
      pair: lb(),
      amountBase: USDC(1_000),
      amountQuote: USDC(1_000),
      minBinId: -35,
      maxBinId: 10,
    });
    expect(sendExpectFail(svm, maker, [ix]).join("\n")).to.contain("OutsideBand");
  });

  it("blocks anyone but the maker from deploying inventory", async () => {
    const ix = await client.addLiquidity({
      authority: trader.publicKey,
      mandate,
      m: m(),
      pair: lb(),
      amountBase: USDC(1_000),
      amountQuote: USDC(1_000),
      minBinId: -10,
      maxBinId: 10,
    });
    expect(sendExpectFail(svm, trader, [ix]).join("\n")).to.contain("Unauthorized");
  });

  it("maker deploys vault inventory into DLMM via CPI (inside the band)", async () => {
    const ix = await client.addLiquidity({
      authority: maker.publicKey,
      mandate,
      m: m(),
      pair: lb(),
      amountBase: USDC(10_000),
      amountQuote: USDC(10_000),
      minBinId: -8,
      maxBinId: 8,
      strategy: StrategyType.SpotImBalanced,
    });
    send(svm, maker, [ix]);
    const s = m();
    expect(tokenBalance(svm, s.baseVault) < 20_000_000_000n).to.eq(true);
    expect(tokenBalance(svm, s.quoteVault) < 20_000_000_000n).to.eq(true);
    expect(tokenBalance(svm, pair.reserveX) > 0n).to.eq(true);
  });

  it("anyone can snapshot; a well-quoted book passes", async () => {
    send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate, m: m() })]);
    const s = m();
    expect(s.last.ok, JSON.stringify(s.last)).to.eq(true);
    expect(s.last.spreadBps).to.be.lte(TERMS.maxSpreadBps);
    expect(s.last.bidDepthQuote.toNumber()).to.be.gte(500_000_000);
    expect(s.last.askDepthQuote.toNumber()).to.be.gte(500_000_000);
    expect(s.curSnapshots).to.eq(1);
  });

  it("rate-limits snapshots", async () => {
    warp(svm, 2);
    const logs = sendExpectFail(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate, m: m() })]);
    expect(logs.join("\n")).to.contain("SnapshotTooSoon");
  });

  it("traders can trade against the mandated liquidity", async () => {
    const before = readActiveId(svm, pair.lbPair);
    dlmmSwap(svm, trader, pair, 3_000_000_000n, false, [-1, 0]); // buy base with 3,000 quote
    expect(readActiveId(svm, pair.lbPair)).to.be.gte(before);
  });

  it("a compliant period pays the maker", async () => {
    warp(svm, 3600);
    send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate, m: m() })]);
    const s = m();
    expect(s.currentPeriod).to.eq(1);
    expect(s.periodsOk).to.eq(1);
    expect(s.feesEarned.toNumber()).to.eq(1_000_000);

    const log = client.decodeScoreLog(svm.getAccount(s.scoreLog)!.data);
    expect(log.count).to.eq(1);
    expect(log.entries[0].status).to.eq(1);

    const makerQuote = ata(quote, maker.publicKey);
    const before = tokenBalance(svm, makerQuote);
    send(svm, maker, [await client.claimMakerFees({ mandate, m: s })]);
    expect(tokenBalance(svm, makerQuote) - before).to.eq(1_000_000n);
  });

  it("withdrawals can only return inventory to the vaults (no dump path)", async () => {
    const makerBase = ensureAta(svm, maker, base, maker.publicKey);
    const makerBaseBefore = tokenBalance(svm, makerBase);
    const s = m();
    const vaultBaseBefore = tokenBalance(svm, s.baseVault);
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate, m: s, pair: lb(), bps: 5_000 })]);
    expect(tokenBalance(svm, s.baseVault) > vaultBaseBefore).to.eq(true);
    expect(tokenBalance(svm, makerBase)).to.eq(makerBaseBefore);
  });

  it("an empty book fails snapshots; 3 failed periods slash the bond", async () => {
    // Maker pulls everything and stops quoting.
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate, m: m(), pair: lb(), bps: 10_000 })]);
    warp(svm, 20);
    for (let i = 0; i < 3; i++) {
      send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate, m: m() })]);
      expect(m().last.ok).to.eq(false);
      warp(svm, 3600);
    }
    send(svm, cranker, [await client.finalize({ mandate, m: m() })]);
    const s = m();
    expect(statusName(s.status)).to.eq("Breached");
    expect(s.consecutiveFailed).to.eq(3);
    expect(s.bondSlashed.toNumber()).to.eq(50_000_000);

    const profile = client.decodeMakerProfile(svm.getAccount(pda.makerProfile(maker.publicKey))!.data);
    expect(profile.mandatesBreached).to.eq(1);
    expect(profile.periodsOk.toNumber()).to.eq(1);
    expect(profile.periodsFailed.toNumber()).to.eq(3);
  });

  it("after breach anyone can unwind and settle; funds are split correctly", async () => {
    // Close the (already empty) position — permissionless after breach.
    send(svm, cranker, [await client.closePosition({ authority: cranker.publicKey, mandate, m: m() })]);
    expect(m().position.toBase58()).to.eq(PublicKey.default.toBase58());

    const s = m();
    const issuerBase = ata(base, issuer.publicKey);
    const issuerQuote = ata(quote, issuer.publicKey);
    const makerQuote = ata(quote, maker.publicKey);
    const [ib, iq, mq] = [tokenBalance(svm, issuerBase), tokenBalance(svm, issuerQuote), tokenBalance(svm, makerQuote)];
    const [vb, vq, vf] = [tokenBalance(svm, s.baseVault), tokenBalance(svm, s.quoteVault), tokenBalance(svm, s.feeVault)];

    send(svm, cranker, [await client.settle({ mandate, m: s })]);
    expect(statusName(m().status)).to.eq("Settled");
    expect(tokenBalance(svm, issuerBase) - ib).to.eq(vb);
    // issuer: all quote inventory + unused fees (23 USDC) + slashed half of the bond (50 USDC)
    expect(tokenBalance(svm, issuerQuote) - iq).to.eq(vq + vf + 50_000_000n);
    // maker: unslashed half of the bond (fees for period 0 were already claimed)
    expect(tokenBalance(svm, makerQuote) - mq).to.eq(50_000_000n);
  });
});
