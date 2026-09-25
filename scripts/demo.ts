/**
 * Runs the full Mandated-launch flow against a cluster and writes the resulting
 * addresses to app/public/demo.json (used by the web app) and .keys/ (bot keypairs). Off
 * localnet set CLUSTER (e.g. devnet): outputs go to app/public/demo.devnet.json and .keys/devnet/.
 *
 *   ./scripts/localnet.sh            # in another terminal
 *   npx tsx scripts/demo.ts          # RPC_URL defaults to http://127.0.0.1:8899
 *
 * Flow: router → DBC config (leftover_receiver = router) → token launch → buys to
 * graduation → DAMM v2 migration → withdraw leftover → DLMM pair at the graduated
 * price → mandate (register launch, route leftover) → maker accepts.
 * A second mandate is left open for the "accept" flow in the UI.
 */
import fs from "fs";
import path from "path";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MandateTerms, binArrayIndex, binIdForAtomicPrice, decodeDammPool, dlmmInitBinArrayIx, pda } from "../sdk/src";
import { RPC_URL, loadKeypair, log, makeClient, sendAndConfirm, sendIxs } from "../keeper/common";

const ROOT = path.resolve(__dirname, "..");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
// DLMM PresetParameter2 for the demo pair. Mainnet/localnet: bin step 25. Devnet only has
// bin step 10 presets, e.g. DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn.
const DLMM_PRESET = new PublicKey(process.env.DLMM_PRESET ?? "FxGzUdJZWPCe7LiZvB9YLDtyHBZcC8EBpG2Hhw9T8Yts");
const DAMM_V2_CONFIG_FIXED_25 = new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd");
const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]) {
  return sendAndConfirm(conn, tx, signers);
}

async function newMint(conn: Connection, payer: Keypair, decimals: number): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  await sendTx(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null),
    ),
    [payer, mint],
  );
  return mint.publicKey;
}

async function mintTo(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint) {
  const a = getAssociatedTokenAddressSync(mint, owner, true);
  await sendTx(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint),
      createMintToInstruction(mint, a, payer.publicKey, amount),
    ),
    [payer],
  );
}

async function ensureAta(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey) {
  const a = getAssociatedTokenAddressSync(mint, owner, true);
  await sendTx(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint)), [payer]);
  return a;
}

async function fund(conn: Connection, payer: Keypair, to: PublicKey, sol: number) {
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  const have = await conn.getBalance(to);
  if (have >= want) return;
  await sendTx(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: want - have })), [payer]);
}

const CLUSTER_NAME = process.env.CLUSTER ?? "localnet";
const SUFFIX = CLUSTER_NAME === "localnet" ? "" : `.${CLUSTER_NAME}`;

const KEY_DIR = path.join(ROOT, ".keys", CLUSTER_NAME === "localnet" ? "" : CLUSTER_NAME);

function saveKey(name: string, kp: Keypair) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(path.join(KEY_DIR, `${name}.json`), JSON.stringify(Array.from(kp.secretKey)));
}

/** Off localnet, reuse helper keys from a previous run so their SOL is not stranded. */
function helperKey(name: string): Keypair {
  const p = path.join(KEY_DIR, `${name}.json`);
  if (CLUSTER_NAME !== "localnet" && fs.existsSync(p)) return loadKeypair(p);
  const kp = Keypair.generate();
  saveKey(name, kp);
  return kp;
}

async function createDlmmPair(conn: Connection, payer: Keypair, tokenX: PublicKey, tokenY: PublicKey, activeId: number) {
  const [minKey, maxKey] = Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) === 1 ? [tokenY, tokenX] : [tokenX, tokenY];
  const lbPair = PublicKey.findProgramAddressSync([DLMM_PRESET.toBuffer(), minKey.toBuffer(), maxKey.toBuffer()], DLMM_PROGRAM_ID)[0];
  const reserveX = PublicKey.findProgramAddressSync([lbPair.toBuffer(), tokenX.toBuffer()], DLMM_PROGRAM_ID)[0];
  const reserveY = PublicKey.findProgramAddressSync([lbPair.toBuffer(), tokenY.toBuffer()], DLMM_PROGRAM_ID)[0];
  const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), lbPair.toBuffer()], DLMM_PROGRAM_ID)[0];
  const data = Buffer.alloc(8 + 4 + 96);
  Buffer.from([73, 59, 36, 120, 237, 83, 108, 198]).copy(data, 0); // initialize_lb_pair2
  data.writeInt32LE(activeId, 8);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const ix = {
    programId: DLMM_PROGRAM_ID,
    keys: [
      rw(lbPair), ro(DLMM_PROGRAM_ID), ro(tokenX), ro(tokenY), rw(reserveX), rw(reserveY), rw(oracle), ro(DLMM_PRESET),
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      ro(DLMM_PROGRAM_ID), ro(DLMM_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId),
      ro(DLMM_EVENT_AUTHORITY), ro(DLMM_PROGRAM_ID),
    ],
    data,
  };
  await sendIxs(conn, payer, [ix as any]);
  const idx = [...new Set([binArrayIndex(activeId - 35), binArrayIndex(activeId), binArrayIndex(activeId + 34)])];
  await sendIxs(conn, payer, idx.map((i) => dlmmInitBinArrayIx(lbPair, i, payer.publicKey)));
  return lbPair;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const launchpad = loadKeypair();
  const isLocal = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
  if (isLocal) {
    const sig = await conn.requestAirdrop(launchpad.publicKey, 1_000 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  log("demo", `rpc=${RPC_URL} launchpad=${launchpad.publicKey.toBase58()}`);
  const client = makeClient(conn, launchpad);
  const dbc = new DynamicBondingCurveClient(conn, "confirmed");

  const creator = helperKey("creator");
  const buyer = helperKey("buyer");
  const maker = helperKey("maker");
  const trader = helperKey("trader");
  // Off localnet, fund just enough: the maker pays for its position and bin arrays.
  const sol = isLocal ? [20, 20, 20, 20] : [0.1, 0.05, 0.4, 0.1];
  for (const [i, k] of [creator, buyer, maker, trader].entries()) await fund(conn, launchpad, k.publicKey, sol[i]);

  const quote = await newMint(conn, launchpad, 6); // demo "USDC"
  await mintTo(conn, launchpad, quote, buyer.publicKey, 1_000_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, launchpad.publicKey, 1_000_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, maker.publicKey, 10_000n * 1_000_000n);
  await mintTo(conn, launchpad, quote, trader.publicKey, 100_000n * 1_000_000n);
  log("demo", `quote mint ${quote.toBase58()}`);

  // 1) Router + Mandated DBC config
  const router = pda.router(launchpad.publicKey);
  if (!(await conn.getAccountInfo(router))) await sendIxs(conn, launchpad, [await client.initRouter({ authority: launchpad.publicKey })]);
  const config = Keypair.generate();
  const params = buildCurveWithMarketCap({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 6, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 100_000_000 },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: 20_000,
    migrationMarketCap: 100_000,
  });
  await sendTx(conn, await dbc.partner.createConfig({ ...params, config: config.publicKey, feeClaimer: launchpad.publicKey, leftoverReceiver: router, payer: launchpad.publicKey, quoteMint: quote }), [launchpad, config]);
  log("demo", `DBC config ${config.publicKey.toBase58()} (leftover_receiver = router ${router.toBase58()})`);

  // 2) Launch + graduate
  const baseMint = Keypair.generate();
  await sendTx(conn, await dbc.creator.createPool({ name: "Mandated Demo", symbol: "MAND", uri: "https://mandate.example/mand.json", payer: creator.publicKey, poolCreator: creator.publicKey, config: config.publicKey, baseMint: baseMint.publicKey }), [creator, baseMint]);
  const dbcPool = deriveDbcPoolAddress(quote, baseMint.publicKey, config.publicKey);
  await sendTx(conn, await dbc.pool.swap2({ owner: buyer.publicKey, pool: dbcPool, swapMode: SwapMode.PartialFill, amountIn: new BN(params.migrationQuoteThreshold.toString()).muln(2), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null }), [buyer]);
  const mig = await dbc.migration.migrateToDammV2({ payer: launchpad.publicKey, pool: dbcPool, dammConfig: DAMM_V2_CONFIG_FIXED_25 });
  await sendTx(conn, mig.transaction, [launchpad, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair]);
  const dammPool = deriveDammV2PoolAddress(DAMM_V2_CONFIG_FIXED_25, baseMint.publicKey, quote);
  await ensureAta(conn, launchpad, baseMint.publicKey, router);
  await sendTx(conn, await dbc.migration.withdrawLeftover({ payer: launchpad.publicKey, pool: dbcPool }), [launchpad]);
  log("demo", `token ${baseMint.publicKey.toBase58()} graduated to DAMM v2 ${dammPool.toBase58()}`);

  // 3) DLMM pair at the graduated price
  const pool = decodeDammPool((await conn.getAccountInfo(dammPool))!.data);
  const preset = await conn.getAccountInfo(DLMM_PRESET);
  if (!preset) throw new Error(`DLMM preset ${DLMM_PRESET.toBase58()} not found on this cluster; set DLMM_PRESET`);
  const binStep = preset.data.readUInt16LE(8);
  const activeId = binIdForAtomicPrice(Number(pool.sqrtPrice) ** 2 / 2 ** 128, binStep);
  const lbPair = await createDlmmPair(conn, launchpad, baseMint.publicKey, quote, activeId);
  log("demo", `DLMM pair ${lbPair.toBase58()} bin step ${binStep}, active bin ${activeId}`);

  // 4) Mandates
  await ensureAta(conn, launchpad, baseMint.publicKey, launchpad.publicKey);
  const terms: MandateTerms = {
    feePerPeriod: new BN(1_000_000), periodSecs: 120, durationPeriods: 720, bondAmount: new BN(250_000_000),
    maxSpreadBps: 100, minDepthQuote: new BN(500_000_000), depthWindowBps: 200, bandBps: 500,
    anchorTwapSecs: 120, anchorSpeedBpsPerMin: 200, liquidityLockSecs: 20, maxConsecutiveFailures: 5, slashBps: 5_000,
  };
  const mandate = pda.mandate(launchpad.publicKey, baseMint.publicKey, 1);
  await sendIxs(conn, launchpad, [
    await client.createMandate({ issuer: launchpad.publicKey, baseMint: baseMint.publicKey, quoteMint: quote, lbPair, referencePool: dammPool, id: 1, terms, baseDeposit: new BN(0), quoteDeposit: new BN(5_000_000_000), feeBudget: new BN(720_000_000) }),
    await client.registerLaunch({ authority: launchpad.publicKey, baseMint: baseMint.publicKey, mandate }),
  ]);
  const m0 = client.decodeMandate((await conn.getAccountInfo(mandate))!.data);
  await sendIxs(conn, launchpad, [await client.routeLeftover({ routerAuthority: launchpad.publicKey, mandate, m: m0 })]);
  const makerClient = makeClient(conn, maker);
  const m1 = client.decodeMandate((await conn.getAccountInfo(mandate))!.data);
  await sendIxs(conn, maker, [await makerClient.accept({ maker: maker.publicKey, mandate, m: m1 })]);
  log("demo", `mandate ${mandate.toBase58()} funded from DBC leftover and accepted by ${maker.publicKey.toBase58()}`);

  const openMandate = pda.mandate(launchpad.publicKey, baseMint.publicKey, 2);
  await sendIxs(conn, launchpad, [
    await client.createMandate({ issuer: launchpad.publicKey, baseMint: baseMint.publicKey, quoteMint: quote, lbPair, referencePool: dammPool, id: 2, terms: { ...terms, bondAmount: new BN(500_000_000), feePerPeriod: new BN(2_000_000) }, baseDeposit: new BN(0), quoteDeposit: new BN(2_000_000_000), feeBudget: new BN(1_440_000_000) }),
  ]);

  const out = {
    cluster: RPC_URL,
    launchpad: launchpad.publicKey.toBase58(),
    router: router.toBase58(),
    dbcConfig: config.publicKey.toBase58(),
    dbcPool: dbcPool.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    quoteMint: quote.toBase58(),
    dammPool: dammPool.toBase58(),
    lbPair: lbPair.toBase58(),
    mandates: [mandate.toBase58(), openMandate.toBase58()],
    maker: maker.publicKey.toBase58(),
    trader: trader.publicKey.toBase58(),
  };
  const outPath = path.join(ROOT, `app/public/demo${SUFFIX}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log("demo", `wrote ${outPath}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
