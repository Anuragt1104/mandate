/**
 * Building blocks for launching tokens the Mandated way: a Meteora DBC config whose
 * leftover supply goes to a Mandate router, launch + graduation to DAMM v2, and a DLMM
 * pair at the graduated price. Shared by scripts/demo.ts and scripts/simulate.ts.
 */
import fs from "fs";
import path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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
import { binArrayIndex, binIdForAtomicPrice, decodeDammPool, dlmmInitBinArrayIx } from "../../sdk/src";
import { RPC_URL, loadKeypair, sendAndConfirm, sendIxs } from "../../keeper/common";

export const ROOT = path.resolve(__dirname, "../..");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
// DLMM PresetParameter2 for new pairs. Mainnet/localnet: bin step 25. Devnet only has
// bin step 10 presets, e.g. DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn.
export const DLMM_PRESET = new PublicKey(process.env.DLMM_PRESET ?? "FxGzUdJZWPCe7LiZvB9YLDtyHBZcC8EBpG2Hhw9T8Yts");
export const DAMM_V2_CONFIG_FIXED_25 = new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd");
const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];

export const CLUSTER_NAME = process.env.CLUSTER ?? "localnet";
export const IS_LOCAL = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
export const SUFFIX = CLUSTER_NAME === "localnet" ? "" : `.${CLUSTER_NAME}`;
export const KEY_DIR = path.join(ROOT, ".keys", CLUSTER_NAME === "localnet" ? "" : CLUSTER_NAME);

export function saveKey(name: string, kp: Keypair) {
  const p = path.join(KEY_DIR, `${name}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
}

/** A named keypair under .keys/<cluster>/; reused across runs off localnet so SOL is not stranded. */
export function helperKey(name: string, reuseOnLocal = false): Keypair {
  const p = path.join(KEY_DIR, `${name}.json`);
  if ((CLUSTER_NAME !== "localnet" || reuseOnLocal) && fs.existsSync(p)) return loadKeypair(p);
  const kp = Keypair.generate();
  saveKey(name, kp);
  return kp;
}

export async function newMint(conn: Connection, payer: Keypair, decimals: number): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  await sendAndConfirm(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null),
    ),
    [payer, mint],
  );
  return mint.publicKey;
}

export async function mintTo(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint) {
  const a = getAssociatedTokenAddressSync(mint, owner, true);
  await sendAndConfirm(
    conn,
    new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint), createMintToInstruction(mint, a, payer.publicKey, amount)),
    [payer],
  );
}

export async function ensureAta(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey) {
  const a = getAssociatedTokenAddressSync(mint, owner, true);
  if (await conn.getAccountInfo(a)) return a;
  await sendAndConfirm(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint)), [payer]);
  return a;
}

/** Top `to` up to `sol` (only the shortfall is sent). */
export async function fund(conn: Connection, payer: Keypair, to: PublicKey, sol: number) {
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  const have = await conn.getBalance(to);
  if (have >= want) return;
  await sendAndConfirm(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: want - have })), [payer]);
}

/** Curve used by the Mandated launchpad config: 1B supply, 10% leftover routed to a mandate. */
export function mandatedCurve() {
  return buildCurveWithMarketCap({
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
}

/** DBC config whose leftover receiver is the launchpad's Mandate router. */
export async function createMandatedConfig(conn: Connection, dbc: DynamicBondingCurveClient, launchpad: Keypair, router: PublicKey, quote: PublicKey) {
  const config = Keypair.generate();
  const params = mandatedCurve();
  await sendAndConfirm(
    conn,
    await dbc.partner.createConfig({ ...params, config: config.publicKey, feeClaimer: launchpad.publicKey, leftoverReceiver: router, payer: launchpad.publicKey, quoteMint: quote }),
    [launchpad, config],
  );
  return config.publicKey;
}

/**
 * Launch a token on a DBC config, buy it out to graduation, migrate to DAMM v2 and pull the
 * leftover supply to the config's leftover receiver (the router).
 */
export async function launchAndGraduate(p: {
  conn: Connection;
  dbc: DynamicBondingCurveClient;
  launchpad: Keypair;
  creator: Keypair;
  buyer: Keypair;
  config: PublicKey;
  quote: PublicKey;
  router: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}) {
  const { conn, dbc, launchpad, creator, buyer, config, quote, router } = p;
  const cfg = await dbc.state.getPoolConfig(config);
  if (!cfg) throw new Error(`DBC config ${config.toBase58()} not found`);
  const baseMint = Keypair.generate();
  await sendAndConfirm(conn, await dbc.creator.createPool({ name: p.name, symbol: p.symbol, uri: p.uri, payer: creator.publicKey, poolCreator: creator.publicKey, config, baseMint: baseMint.publicKey }), [creator, baseMint]);
  const dbcPool = deriveDbcPoolAddress(quote, baseMint.publicKey, config);
  await sendAndConfirm(
    conn,
    await dbc.pool.swap2({ owner: buyer.publicKey, pool: dbcPool, swapMode: SwapMode.PartialFill, amountIn: new BN(cfg.migrationQuoteThreshold.toString()).muln(2), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null }),
    [buyer],
  );
  const mig = await dbc.migration.migrateToDammV2({ payer: launchpad.publicKey, pool: dbcPool, dammConfig: DAMM_V2_CONFIG_FIXED_25 });
  await sendAndConfirm(conn, mig.transaction, [launchpad, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair]);
  const dammPool = deriveDammV2PoolAddress(DAMM_V2_CONFIG_FIXED_25, baseMint.publicKey, quote);
  await ensureAta(conn, launchpad, baseMint.publicKey, router);
  await sendAndConfirm(conn, await dbc.migration.withdrawLeftover({ payer: launchpad.publicKey, pool: dbcPool }), [launchpad]);
  return { baseMint: baseMint.publicKey, dbcPool, dammPool };
}

/** A DLMM pair (initialize_lb_pair2) at `activeId`, with the bin arrays around it. */
export async function createDlmmPair(conn: Connection, payer: Keypair, tokenX: PublicKey, tokenY: PublicKey, activeId: number, preset = DLMM_PRESET) {
  const [minKey, maxKey] = Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) === 1 ? [tokenY, tokenX] : [tokenX, tokenY];
  const lbPair = PublicKey.findProgramAddressSync([preset.toBuffer(), minKey.toBuffer(), maxKey.toBuffer()], DLMM_PROGRAM_ID)[0];
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
      rw(lbPair), ro(DLMM_PROGRAM_ID), ro(tokenX), ro(tokenY), rw(reserveX), rw(reserveY), rw(oracle), ro(preset),
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

/** DLMM pair for a graduated token, opened at the DAMM v2 pool's price. */
export async function pairAtGraduatedPrice(conn: Connection, payer: Keypair, baseMint: PublicKey, quote: PublicKey, dammPool: PublicKey, preset = DLMM_PRESET) {
  const pool = decodeDammPool((await conn.getAccountInfo(dammPool))!.data);
  const presetInfo = await conn.getAccountInfo(preset);
  if (!presetInfo) throw new Error(`DLMM preset ${preset.toBase58()} not found on this cluster; set DLMM_PRESET`);
  const binStep = presetInfo.data.readUInt16LE(8);
  const atomic = Number(pool.sqrtPrice) ** 2 / 2 ** 128;
  const activeId = binIdForAtomicPrice(pool.tokenA.equals(baseMint) ? atomic : 1 / atomic, binStep);
  const lbPair = await createDlmmPair(conn, payer, baseMint, quote, activeId, preset);
  return { lbPair, binStep, activeId };
}
