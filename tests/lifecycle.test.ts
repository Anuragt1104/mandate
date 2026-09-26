import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
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
  ensureAta,
  startSvm,
  tokenBalance,
  warp,
  writeReferencePool,
} from "./helpers";
import { MandateClient, MandateTerms, pda, decodeLbPair, decodeBinArray, decodePosition, measureAccounts, newSession, scoreSample, statusName, takeSample, type BinInfo } from "../sdk/src";

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
        // The whole term's fees, as acceptance requires.
        feeBudget: new BN(terms.feePerPeriod.toNumber() * terms.durationPeriods),
      }),
    ]);
    return key;
  }

  const SETUP = 60; // scoring starts this long after acceptance

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
    const s0 = load(key);
    expect(s0.startTs.toNumber()).to.be.greaterThan(0);
    warp(svm, SETUP);
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
    warp(svm, SETUP + 60 * 80); // 80 periods with no snapshots
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

  it("a maker cannot accept an agreement whose fee vault doesn't cover the term", async () => {
    const key = pda.mandate(issuer.publicKey, base, 16);
    send(svm, issuer, [
      await client.createMandate({
        issuer: issuer.publicKey,
        baseMint: base,
        quoteMint: quote,
        lbPair: pair.lbPair,
        referencePool: refPool,
        id: 16,
        terms: TERMS,
        baseDeposit: U(10),
        quoteDeposit: U(10),
        feeBudget: U(5.99),
      }),
    ]);
    const logs = sendExpectFail(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("UnderfundedFees");
    // Topping up the budget makes it acceptable.
    send(svm, issuer, [await client.deposit({ depositor: issuer.publicKey, mandate: key, m: load(key), base: U(0), quote: U(0), fees: U(0.01) })]);
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
    expect(statusName(load(key).status)).to.eq("Active");
  });

  it("a batch of finalizes that breaches on the first call does not roll back the breach", async () => {
    const terms = { ...TERMS, periodSecs: 60, durationPeriods: 100, maxConsecutiveFailures: 1 };
    const key = await newMandate(17, terms);
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate: key, m: load(key) })]);
    warp(svm, SETUP + 5);
    // No position: the check fails, and the next finalize breaches.
    send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: key, m: load(key) })]);
    expect(load(key).last.ok).to.eq(false);
    warp(svm, 60 * 40);
    const fin = await client.finalize({ mandate: key, m: load(key) });
    send(svm, cranker, [fin, fin, fin]);
    const s = load(key);
    expect(statusName(s.status)).to.eq("Breached");
    expect(s.bondSlashed.toNumber()).to.eq(50_000_000);
    // And again on its own: still a no-op.
    send(svm, cranker, [await client.finalize({ mandate: key, m: load(key) })]);
  });

  it("leftover that reaches the router after cancellation goes to the issuer", async () => {
    const launchpad = fundedKeypair(svm);
    const key = await newMandate(18);
    send(svm, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
    send(svm, launchpad, [await client.registerLaunch({ authority: launchpad.publicKey, baseMint: base, mandate: key })]);
    send(svm, issuer, [await client.cancel({ mandate: key, m: load(key) })]);
    const router = pda.router(launchpad.publicKey);
    ensureAta(svm, launchpad, base, router);
    mintTo(svm, mintAuth, base, router, 1_000_000n);
    // Routing into a cancelled mandate is refused...
    const logs = sendExpectFail(svm, cranker, [await client.routeLeftover({ routerAuthority: launchpad.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("InvalidStatus");
    // ...and anyone can recover it to the issuer instead.
    const before = tokenBalance(svm, ata(base, issuer.publicKey));
    send(svm, cranker, [await client.recoverLeftover({ routerAuthority: launchpad.publicKey, mandate: key, m: load(key) })]);
    expect(tokenBalance(svm, ata(base, issuer.publicKey)) - before).to.eq(1_000_000n);
    expect(tokenBalance(svm, ata(base, router))).to.eq(0n);
  });

  it("leftover cannot be recovered while the mandate is live", async () => {
    const launchpad = fundedKeypair(svm);
    const key = await newMandate(19);
    send(svm, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
    send(svm, launchpad, [await client.registerLaunch({ authority: launchpad.publicKey, baseMint: base, mandate: key })]);
    const router = pda.router(launchpad.publicKey);
    ensureAta(svm, launchpad, base, router);
    mintTo(svm, mintAuth, base, router, 1_000n);
    const logs = sendExpectFail(svm, cranker, [await client.recoverLeftover({ routerAuthority: launchpad.publicKey, mandate: key, m: load(key) })]);
    expect(logs.join("\n")).to.contain("InvalidStatus");
  });

  it("tokens sent to a settled or cancelled mandate's vaults are swept to fixed recipients", async () => {
    const key = await newMandate(20);
    send(svm, issuer, [await client.cancel({ mandate: key, m: load(key) })]);
    const m = load(key);
    // Someone transfers quote into the cancelled mandate's quote vault.
    send(svm, issuer, [createTransferInstruction(ata(quote, issuer.publicKey), m.quoteVault, issuer.publicKey, 7_000_000n)]);
    const before = tokenBalance(svm, ata(quote, issuer.publicKey));
    send(svm, cranker, [await client.sweep({ mandate: key, m })]);
    expect(tokenBalance(svm, ata(quote, issuer.publicKey)) - before).to.eq(7_000_000n);
    expect(tokenBalance(svm, m.quoteVault)).to.eq(0n);
    // Nothing left: a second sweep is refused.
    const logs = sendExpectFail(svm, cranker, [await client.sweep({ mandate: key, m })]);
    expect(logs.join("\n")).to.contain("InsufficientVault");
  });

  it("the SDK's committed measurement equals the program's, atom for atom, across book states", async () => {
    const key = await newMandate(21);
    await acceptAndQuote(key, -30);
    warp(svm, SETUP + 5);
    const trader = fundedKeypair(svm);
    mintTo(svm, mintAuth, quote, trader.publicKey, 10_000n * 1_000_000n);
    mintTo(svm, mintAuth, base, trader.publicKey, 10_000n * 1_000_000n);
    const compare = async (what: string) => {
      send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate: key, m: load(key) })]);
      const m = load(key);
      const pos = m.position.equals(PublicKey.default) ? null : decodePosition(svm.getAccount(m.position)!.data);
      const arrays = new Map<number, BinInfo[]>();
      for (const i of [-2, -1, 0, 1]) {
        const acc = svm.getAccount(pda.binArray(pair.lbPair, i));
        if (acc) arrays.set(i, decodeBinArray(acc.data).bins);
      }
      const sdk = measureAccounts(m, 25, pos, arrays, m.last.anchorBin);
      expect(sdk.status, what).to.eq("measured");
      if (sdk.status !== "measured") return;
      expect([sdk.ok, sdk.bidDepth.toString(), sdk.askDepth.toString(), sdk.spreadBps], what).to.deep.eq([
        !!m.last.ok, m.last.bidDepthQuote.toString(), m.last.askDepthQuote.toString(), m.last.spreadBps,
      ]);
      // The read-only verifier's sample of the same position, replayed against the same terms
      // at the same reference, gives the program's verdict and depths too.
      if (!pos) return;
      const shim: any = {
        getAccountInfo: async (k: PublicKey) => svm.getAccount(k),
        getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({ context: { slot: 1 }, value: ks.map((k) => svm.getAccount(k)) }),
      };
      const session = await newSession(shim, { cluster: "localnet", pair: pair.lbPair, position: m.position, periodSecs: 600 });
      const sample = await takeSample(shim, session);
      const replay = scoreSample(session, sample, { minDepth: Number(m.terms.minDepthQuote) / 1e6, depthWindowBps: m.terms.depthWindowBps, maxSpreadBps: m.terms.maxSpreadBps }, m.last.anchorBin);
      expect([replay.result === "met", Math.round(replay.bid! * 1e6).toString(), Math.round(replay.ask! * 1e6).toString(), replay.spreadBps], `${what} (verifier)`).to.deep.eq([
        !!m.last.ok, m.last.bidDepthQuote.toString(), m.last.askDepthQuote.toString(), m.last.spreadBps,
      ]);
    };
    await compare("freshly quoted");
    dlmmSwap(svm, trader, pair, 300_000_000n, false, [0, 1]);
    await compare("after a buy through the asks");
    dlmmSwap(svm, trader, pair, 150_000_000n, true, [0, -1]);
    await compare("after a sell into the bids");
    warp(svm, 31);
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb(), bps: 3_333 })]);
    await compare("after a partial withdrawal (fractional amounts)");
    send(svm, maker, [await client.removeLiquidity({ authority: maker.publicKey, mandate: key, m: load(key), pair: lb() })]);
    await compare("after withdrawing everything");
  });
});
