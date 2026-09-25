/**
 * End-to-end Meteora launch flow on mainnet program binaries:
 *   DBC config (leftover_receiver = Mandate router) → DBC pool → buys to graduation
 *   → migration to DAMM v2 → withdraw_leftover → route_leftover into a mandate
 *   → maker quotes on DLMM against the *real* graduated DAMM v2 pool as reference.
 */
import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LiteSVM } from "litesvm";
import {
  ata,
  createDlmmPair,
  createMint,
  ensureAta,
  fundedKeypair,
  initBinArrays,
  mandateProgram,
  mintTo,
  send,
  sendTx,
  startSvm,
  tokenBalance,
  warp,
} from "./helpers";
import { SvmConnection } from "./svmConnection";
import { MandateClient, MandateTerms, binIdForAtomicPrice, binArrayIndex, decodeDammPool, decodeLbPair, pda, statusName } from "../sdk/src";

const DAMM_V2_CONFIG_FIXED_25 = new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd");
const TOTAL_SUPPLY = 1_000_000_000;
const LEFTOVER = 100_000_000;

describe("launch: DBC → DAMM v2 → Mandate (mainnet Meteora binaries)", () => {
  let svm: LiteSVM;
  let dbc: DynamicBondingCurveClient;
  let client: MandateClient;
  let launchpad: Keypair, creator: Keypair, buyer: Keypair, maker: Keypair, cranker: Keypair;
  let quote: PublicKey;
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  let dbcPool: PublicKey, dammPool: PublicKey, router: PublicKey, mandate: PublicKey;
  let migrationQuoteThreshold: BN;
  let leftoverAmount = 0n;

  const m = () => client.decodeMandate(svm.getAccount(mandate)!.data);

  before(() => {
    svm = startSvm();
    dbc = new DynamicBondingCurveClient(new SvmConnection(svm), "confirmed");
    client = new MandateClient(mandateProgram());
    launchpad = fundedKeypair(svm);
    creator = fundedKeypair(svm);
    buyer = fundedKeypair(svm);
    maker = fundedKeypair(svm);
    cranker = fundedKeypair(svm);
    const mintAuth = fundedKeypair(svm);
    quote = createMint(svm, mintAuth, 6); // "USDC"
    mintTo(svm, mintAuth, quote, buyer.publicKey, 10_000_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, launchpad.publicKey, 100_000n * 1_000_000n);
    mintTo(svm, mintAuth, quote, maker.publicKey, 10_000n * 1_000_000n);
    router = pda.router(launchpad.publicKey);
  });

  it("launchpad creates its Mandate router", async () => {
    send(svm, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
    expect(svm.getAccount(router)).to.not.eq(null);
  });

  it("launchpad creates a 'Mandated' DBC config with leftover_receiver = router", async () => {
    const params = buildCurveWithMarketCap({
      token: {
        tokenType: TokenType.SPLToken,
        tokenBaseDecimal: TokenDecimal.SIX,
        tokenQuoteDecimal: 6,
        tokenAuthorityOption: TokenAuthorityOption.Immutable,
        totalTokenSupply: TOTAL_SUPPLY,
        leftover: LEFTOVER,
      },
      fee: {
        baseFeeParams: {
          baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
          feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
        },
        dynamicFeeEnabled: false,
        collectFeeMode: CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: 0,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: MigrationOption.MET_DAMM_V2,
        migrationFeeOption: MigrationFeeOption.FixedBps25,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      },
      liquidityDistribution: {
        partnerPermanentLockedLiquidityPercentage: 100,
        partnerLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 0,
        creatorLiquidityPercentage: 0,
      },
      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0,
      },
      activationType: ActivationType.Timestamp,
      initialMarketCap: 20_000,
      migrationMarketCap: 100_000,
    });
    migrationQuoteThreshold = new BN(params.migrationQuoteThreshold.toString());
    const tx = await dbc.partner.createConfig({
      ...params,
      config: config.publicKey,
      feeClaimer: launchpad.publicKey,
      leftoverReceiver: router,
      payer: launchpad.publicKey,
      quoteMint: quote,
    });
    sendTx(svm, tx, [launchpad, config]);
    expect(svm.getAccount(config.publicKey)).to.not.eq(null);
  });

  it("creator launches a token on the bonding curve", async () => {
    const tx = await dbc.creator.createPool({
      name: "Mandated Token",
      symbol: "MND",
      uri: "https://mandate.example/mnd.json",
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
      config: config.publicKey,
      baseMint: baseMint.publicKey,
    });
    sendTx(svm, tx, [creator, baseMint]);
    dbcPool = deriveDbcPoolAddress(quote, baseMint.publicKey, config.publicKey);
    expect(svm.getAccount(dbcPool)).to.not.eq(null);
  });

  it("buyers complete the curve", async () => {
    warp(svm, 5);
    const amountIn = migrationQuoteThreshold.muln(12).divn(10); // 120% of threshold
    // PartialFill: consume quote only up to the migration threshold.
    const tx = await dbc.pool.swap2({
      owner: buyer.publicKey,
      pool: dbcPool,
      swapMode: SwapMode.PartialFill,
      amountIn,
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
    });
    sendTx(svm, tx, [buyer]);
    expect(tokenBalance(svm, ata(baseMint.publicKey, buyer.publicKey)) > 0n).to.eq(true);
  });

  it("token graduates to a DAMM v2 pool (permissionless migration)", async () => {
    // Mainnet DBC's pool authority holds ~1 SOL used as "flash rent" during migration.
    svm.airdrop(deriveDbcPoolAuthority(), 1_000_000_000n);
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({
      payer: launchpad.publicKey,
      pool: dbcPool,
      dammConfig: DAMM_V2_CONFIG_FIXED_25,
    });
    sendTx(svm, transaction, [launchpad, firstPositionNftKeypair, secondPositionNftKeypair]);
    dammPool = deriveDammV2PoolAddress(DAMM_V2_CONFIG_FIXED_25, baseMint.publicKey, quote);
    const p = decodeDammPool(svm.getAccount(dammPool)!.data);
    expect(p.tokenA.toBase58()).to.eq(baseMint.publicKey.toBase58());
    expect(p.tokenB.toBase58()).to.eq(quote.toBase58());
    expect(p.sqrtPrice > 0n).to.eq(true);
  });

  it("unsold supply is withdrawn to the Mandate router (permissionless)", async () => {
    ensureAta(svm, launchpad, baseMint.publicKey, router);
    const tx = await dbc.migration.withdrawLeftover({ payer: launchpad.publicKey, pool: dbcPool });
    sendTx(svm, tx, [launchpad]);
    // Configured leftover plus curve rounding dust.
    leftoverAmount = tokenBalance(svm, ata(baseMint.publicKey, router));
    expect(leftoverAmount >= BigInt(LEFTOVER) * 1_000_000n).to.eq(true);
    expect(leftoverAmount < BigInt(LEFTOVER + 1_000) * 1_000_000n).to.eq(true);
  });

  it("launchpad creates the token's mandate on a DLMM pair referenced to the DAMM v2 pool", async () => {
    // DLMM pair at the graduated price.
    const p = decodeDammPool(svm.getAccount(dammPool)!.data);
    const price = Number(p.sqrtPrice) ** 2 / 2 ** 128; // quote atomic per base atomic
    const activeId = binIdForAtomicPrice(price, 25);
    const pair = createDlmmPair(svm, launchpad, baseMint.publicKey, quote, 25, activeId);
    initBinArrays(svm, launchpad, pair.lbPair, [binArrayIndex(activeId - 35), binArrayIndex(activeId + 34)]);

    ensureAta(svm, launchpad, baseMint.publicKey, launchpad.publicKey);
    const terms: MandateTerms = {
      feePerPeriod: new BN(5_000_000),
      periodSecs: 3600,
      durationPeriods: 168,
      bondAmount: new BN(250_000_000),
      maxSpreadBps: 100,
      minDepthQuote: new BN(500_000_000),
      depthWindowBps: 200,
      bandBps: 500,
      anchorTwapSecs: 300,
      anchorSpeedBpsPerMin: 100,
      liquidityLockSecs: 30,
      maxConsecutiveFailures: 3,
      slashBps: 10_000,
    };
    mandate = pda.mandate(launchpad.publicKey, baseMint.publicKey, 1);
    send(svm, launchpad, [
      await client.createMandate({
        issuer: launchpad.publicKey,
        baseMint: baseMint.publicKey,
        quoteMint: quote,
        lbPair: pair.lbPair,
        referencePool: dammPool,
        id: 1,
        terms,
        baseDeposit: new BN(0), // inventory comes from the DBC leftover
        quoteDeposit: new BN(5_000_000_000),
        feeBudget: new BN(840_000_000),
      }),
      await client.registerLaunch({ authority: launchpad.publicKey, baseMint: baseMint.publicKey, mandate }),
    ]);
    expect(statusName(m().status)).to.eq("Open");
  });

  it("anyone routes the leftover into the mandate vault", async () => {
    send(svm, cranker, [await client.routeLeftover({ routerAuthority: launchpad.publicKey, mandate, m: m() })]);
    expect(tokenBalance(svm, m().baseVault)).to.eq(leftoverAmount);
    expect(tokenBalance(svm, ata(baseMint.publicKey, router))).to.eq(0n);
  });

  it("maker accepts, quotes around the graduated price, and passes a snapshot", async () => {
    send(svm, maker, [await client.accept({ maker: maker.publicKey, mandate, m: m() })]);
    const lb = decodeLbPair(svm.getAccount(m().lbPair)!.data);
    const lower = lb.activeId - 35;
    send(svm, maker, [await client.openPosition({ maker: maker.publicKey, mandate, m: m(), lowerBinId: lower, width: 70 })]);
    send(svm, maker, [
      await client.addLiquidity({
        authority: maker.publicKey,
        mandate,
        m: m(),
        pair: lb,
        amountBase: new BN(20_000_000).mul(new BN(1_000_000)), // 20M tokens
        amountQuote: new BN(2_000_000_000), // 2,000 USDC
        minBinId: lb.activeId - 10,
        maxBinId: lb.activeId + 10,
      }),
    ]);
    warp(svm, 61); // past the setup grace period
    send(svm, cranker, [await client.snapshot({ cranker: cranker.publicKey, mandate, m: m() })]);
    const last = m().last;
    expect(last.ok, JSON.stringify(last)).to.eq(true);
    expect(last.refDeviationBps).to.be.lte(150);
  });
});
