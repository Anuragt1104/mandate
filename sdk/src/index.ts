/**
 * Mandate TypeScript client: PDA derivation, instruction builders and account decoding.
 * Shared by tests, the keeper/maker bots and the web app.
 */
// Explicit import: Next.js's built-in Buffer polyfill lacks the BigInt readers used below.
import { Buffer } from "buffer";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const MANDATE_PROGRAM_ID = new PublicKey("3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Program constants the off-chain code must agree with (programs/mandate/src/constants.rs). */
/** Scoring starts this long after acceptance (`start_ts`); checks before it record nothing. */
export const SETUP_GRACE_SECS = 60;
export const MAX_FINALIZE_PER_CALL = 32;
export const SPREAD_SIZE_DIVISOR = 10n;
export const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];

export const BINS_PER_ARRAY = 70;

export enum StrategyType {
  SpotOneSide = 0,
  CurveOneSide = 1,
  BidAskOneSide = 2,
  SpotBalanced = 3,
  CurveBalanced = 4,
  BidAskBalanced = 5,
  SpotImBalanced = 6,
  CurveImBalanced = 7,
  BidAskImBalanced = 8,
}

export interface MandateTerms {
  feePerPeriod: BN;
  periodSecs: number;
  durationPeriods: number;
  bondAmount: BN;
  maxSpreadBps: number;
  minDepthQuote: BN;
  depthWindowBps: number;
  bandBps: number;
  anchorTwapSecs: number;
  anchorSpeedBpsPerMin: number;
  liquidityLockSecs: number;
  maxConsecutiveFailures: number;
  slashBps: number;
}

export const STATUS_NAMES = ["Open", "Active", "Breached", "Expired", "Settled", "Cancelled"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

export function statusName(status: any): StatusName {
  const k = Object.keys(status ?? {})[0] ?? "open";
  return (k.charAt(0).toUpperCase() + k.slice(1)) as StatusName;
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

const u64le = (n: number | BN | bigint) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const i32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const i64le = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

export const pda = {
  mandate: (issuer: PublicKey, baseMint: PublicKey, id: number | BN | bigint) =>
    PublicKey.findProgramAddressSync([Buffer.from("mandate"), issuer.toBuffer(), baseMint.toBuffer(), u64le(id)], MANDATE_PROGRAM_ID)[0],
  scoreLog: (mandate: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("score"), mandate.toBuffer()], MANDATE_PROGRAM_ID)[0],
  vault: (mandate: PublicKey, kind: "base" | "quote" | "fee" | "bond") =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), mandate.toBuffer(), Buffer.from(kind)], MANDATE_PROGRAM_ID)[0],
  makerProfile: (maker: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("maker"), maker.toBuffer()], MANDATE_PROGRAM_ID)[0],
  router: (authority: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("router"), authority.toBuffer()], MANDATE_PROGRAM_ID)[0],
  launch: (router: PublicKey, baseMint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("launch"), router.toBuffer(), baseMint.toBuffer()], MANDATE_PROGRAM_ID)[0],
  dlmmPosition: (lbPair: PublicKey, base: PublicKey, lower: number, width: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), lbPair.toBuffer(), base.toBuffer(), i32le(lower), i32le(width)],
      DLMM_PROGRAM_ID,
    )[0],
  binArray: (lbPair: PublicKey, index: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), i64le(index)], DLMM_PROGRAM_ID)[0],
  dlmmOracle: (lbPair: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("oracle"), lbPair.toBuffer()], DLMM_PROGRAM_ID)[0],
};

export function binArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}

/** Bin arrays covering [lower, upper] (inclusive). */
export function binArraysCovering(lbPair: PublicKey, lower: number, upper: number): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = binArrayIndex(lower); i <= binArrayIndex(upper); i++) out.push(pda.binArray(lbPair, i));
  return out;
}

// ---------------------------------------------------------------------------
// Minimal on-chain readers for Meteora accounts (offsets: docs/spec/integration.md)
// ---------------------------------------------------------------------------

export interface LbPairInfo {
  activeId: number;
  binStep: number;
  tokenX: PublicKey;
  tokenY: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
}

export function decodeLbPair(data: Buffer | Uint8Array): LbPairInfo {
  const d = Buffer.from(data);
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
  return {
    activeId: d.readInt32LE(76),
    binStep: d.readUInt16LE(80),
    tokenX: pk(88),
    tokenY: pk(120),
    reserveX: pk(152),
    reserveY: pk(184),
    oracle: pk(552),
  };
}

export interface DammPoolInfo {
  tokenA: PublicKey;
  tokenB: PublicKey;
  sqrtPrice: bigint;
}

export function decodeDammPool(data: Buffer | Uint8Array): DammPoolInfo {
  const d = Buffer.from(data);
  const u128 = (o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
  return { tokenA: new PublicKey(d.subarray(168, 200)), tokenB: new PublicKey(d.subarray(200, 232)), sqrtPrice: u128(456) };
}

export interface PositionInfo {
  lbPair: PublicKey;
  owner: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  shares: bigint[];
}

export function decodePosition(data: Buffer | Uint8Array): PositionInfo {
  const d = Buffer.from(data);
  const shares: bigint[] = [];
  for (let i = 0; i < 70; i++) shares.push(d.readBigUInt64LE(72 + i * 16) + (d.readBigUInt64LE(80 + i * 16) << 64n));
  return {
    lbPair: new PublicKey(d.subarray(8, 40)),
    owner: new PublicKey(d.subarray(40, 72)),
    lowerBinId: d.readInt32LE(7912),
    upperBinId: d.readInt32LE(7916),
    shares,
  };
}

export interface BinInfo {
  amountX: bigint;
  amountY: bigint;
  liquiditySupply: bigint;
}

export function decodeBinArray(data: Buffer | Uint8Array): { index: number; bins: BinInfo[] } {
  const d = Buffer.from(data);
  const bins: BinInfo[] = [];
  for (let i = 0; i < 70; i++) {
    const o = 56 + i * 144;
    bins.push({
      amountX: d.readBigUInt64LE(o),
      amountY: d.readBigUInt64LE(o + 8),
      liquiditySupply: d.readBigUInt64LE(o + 32) + (d.readBigUInt64LE(o + 40) << 64n),
    });
  }
  return { index: Number(d.readBigInt64LE(8)), bins };
}

/**
 * The program's committed-liquidity verdict for a mandate from decoded accounts (see
 * measure.ts): the position (null when none is open) and the bin arrays read, by index.
 * `anchorBin` defaults to the mandate's current reference.
 */
export function measureAccounts(m: any, binStep: number, position: PositionInfo | null, arrays: Map<number, BinInfo[]>, anchorBin: number = m.anchor.bin): CommittedResult {
  return measureCommitted({
    anchorBin,
    binStep,
    position: position ? { lower: position.lowerBinId, upper: position.upperBinId, shares: position.shares } : null,
    binArray: (i) => arrays.get(i),
    terms: { minDepthQuote: BigInt(m.terms.minDepthQuote.toString()), depthWindowBps: m.terms.depthWindowBps, maxSpreadBps: m.terms.maxSpreadBps },
  });
}

// ---------------------------------------------------------------------------
// Reference price ("anchor"): mirror of programs/mandate/src/anchor.rs
// ---------------------------------------------------------------------------

export interface OracleSample {
  cumulative: bigint;
  ts: number;
}

/** Latest observation of a DLMM oracle account, or null before the first swap. */
export function decodeOracleLatest(data: Buffer | Uint8Array): OracleSample | null {
  const d = Buffer.from(data);
  const idx = Number(d.readBigUInt64LE(8));
  if (d.readBigUInt64LE(16) === 0n) return null;
  const o = 32 + idx * 32;
  return { cumulative: (d.readBigInt64LE(o + 8) << 64n) + d.readBigUInt64LE(o), ts: Number(d.readBigInt64LE(o + 24)) };
}

export interface AnchorState {
  bin: number;
  target: number;
  ts: number;
  taintTs: number;
  startCum: bigint;
  startTs: number;
  nextCum: bigint;
  nextTs: number;
}

export function anchorState(m: any): AnchorState {
  const a = m.anchor;
  return {
    bin: a.bin,
    target: a.target,
    ts: Number(a.ts),
    taintTs: Number(a.taintTs),
    startCum: BigInt(a.startCum.toString()),
    startTs: Number(a.startTs),
    nextCum: BigInt(a.nextCum.toString()),
    nextTs: Number(a.nextTs),
  };
}

const floorDiv = (a: bigint, b: bigint) => (a % b === 0n || a >= 0n ? a / b : a / b - 1n);

/**
 * Where the reference will be after the next refresh at `now` (what `add_liquidity` and
 * `snapshot` will see). Pure; does not mutate `state`.
 */
export function projectAnchor(state: AnchorState, sample: OracleSample | null, terms: MandateTerms, binStep: number, now: number): AnchorState {
  const a = { ...state };
  const twap = observe(a, sample, terms.anchorTwapSecs);
  if (twap !== null) step(a, twap, now, terms.anchorSpeedBpsPerMin, binStep);
  return a;
}

function observe(a: AnchorState, s: OracleSample | null, window: number): number | null {
  if (!s || s.ts <= 0) return null;
  // Mirrors anchor.rs: samples at or before a taint may include misattributed time.
  if (a.startTs !== 0 && a.startTs <= a.taintTs) (a.startTs = 0), (a.startCum = 0n);
  if (a.nextTs !== 0 && a.nextTs <= a.taintTs) (a.nextTs = 0), (a.nextCum = 0n);
  if (s.ts <= a.taintTs) return null;
  if (a.nextTs === 0) (a.nextTs = s.ts), (a.nextCum = s.cumulative);
  if (a.startTs === 0) (a.startTs = a.nextTs), (a.startCum = a.nextCum);
  if (s.ts - a.nextTs >= window) {
    a.startTs = a.nextTs;
    a.startCum = a.nextCum;
    a.nextTs = s.ts;
    a.nextCum = s.cumulative;
  }
  const span = s.ts - a.startTs;
  if (span < window || span <= 0) return null;
  return Number(floorDiv(s.cumulative - a.startCum, BigInt(span)));
}

export type ReferenceQuality =
  /** A full clean TWAP window backs the reference. */
  | "ready"
  /** No full window since creation or the last taint yet; the reference holds still. */
  | "warming"
  /** Liquidity was removed and no oracle sample has landed since; the reference holds still. */
  | "tainted"
  /** The pair's oracle hasn't been updated (no swaps) for longer than the TWAP window. */
  | "stale";

/**
 * What currently backs the reference price. The program never moves the reference on a
 * window that isn't "ready"; this makes that state visible instead of implying freshness.
 */
export function referenceQuality(state: AnchorState, sample: OracleSample | null, terms: MandateTerms, now: number): ReferenceQuality {
  const a = { ...state };
  if (!sample) return "warming";
  if (a.taintTs > 0 && sample.ts <= a.taintTs) return "tainted";
  if (observe(a, sample, terms.anchorTwapSecs) === null) return "warming";
  if (now - sample.ts > terms.anchorTwapSecs) return "stale";
  return "ready";
}

function step(a: AnchorState, target: number, now: number, speed: number, binStep: number) {
  a.target = target;
  if (target === a.bin) return void (a.ts = now);
  if (now <= a.ts || speed === 0 || binStep === 0) return;
  const secsPerBinNum = 60 * binStep;
  const accrued = Math.floor(((now - a.ts) * speed) / secsPerBinNum);
  if (accrued === 0) return;
  const cap = Math.max(1, Math.floor(speed / binStep));
  const gap = Math.abs(target - a.bin);
  let mv: number;
  if (accrued >= cap) (a.ts = now), (mv = Math.min(cap, gap));
  else if (accrued >= gap) (a.ts = now), (mv = gap);
  else (a.ts += Math.ceil((accrued * secsPerBinNum) / speed)), (mv = accrued);
  a.bin += target > a.bin ? mv : -mv;
}

/** Human price (quote per base, UI units) of a DLMM bin. */
export function binPrice(binId: number, binStep: number, baseDecimals: number, quoteDecimals: number): number {
  return Math.pow(1 + binStep / 10_000, binId) * Math.pow(10, baseDecimals - quoteDecimals);
}

/** Bin id whose price is closest to `price` (quote per base, atomic units). */
export function binIdForAtomicPrice(price: number, binStep: number): number {
  return Math.round(Math.log(price) / Math.log(1 + binStep / 10_000));
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export class MandateClient {
  constructor(public program: Program<any>) {}

  async createMandate(p: {
    issuer: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lbPair: PublicKey;
    referencePool: PublicKey;
    id: number | BN;
    terms: MandateTerms;
    baseDeposit: BN;
    quoteDeposit: BN;
    feeBudget: BN;
    designatedMaker?: PublicKey;
    issuerBase?: PublicKey;
    issuerQuote?: PublicKey;
  }): Promise<TransactionInstruction> {
    const mandate = pda.mandate(p.issuer, p.baseMint, new BN(p.id.toString()));
    return this.program.methods
      .createMandate(new BN(p.id.toString()), {
        terms: p.terms,
        baseDeposit: p.baseDeposit,
        quoteDeposit: p.quoteDeposit,
        feeBudget: p.feeBudget,
        designatedMaker: p.designatedMaker ?? PublicKey.default,
      })
      .accountsStrict({
        issuer: p.issuer,
        baseMint: p.baseMint,
        quoteMint: p.quoteMint,
        lbPair: p.lbPair,
        oracle: pda.dlmmOracle(p.lbPair),
        referencePool: p.referencePool,
        mandate,
        scoreLog: pda.scoreLog(mandate),
        baseVault: pda.vault(mandate, "base"),
        quoteVault: pda.vault(mandate, "quote"),
        feeVault: pda.vault(mandate, "fee"),
        bondVault: pda.vault(mandate, "bond"),
        issuerBase: p.issuerBase ?? getAssociatedTokenAddressSync(p.baseMint, p.issuer, true),
        issuerQuote: p.issuerQuote ?? getAssociatedTokenAddressSync(p.quoteMint, p.issuer, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async deposit(p: { depositor: PublicKey; mandate: PublicKey; m: any; base: BN; quote: BN; fees: BN }) {
    return this.program.methods
      .deposit(p.base, p.quote, p.fees)
      .accountsStrict({
        depositor: p.depositor,
        mandate: p.mandate,
        baseVault: p.m.baseVault,
        quoteVault: p.m.quoteVault,
        feeVault: p.m.feeVault,
        fromBase: getAssociatedTokenAddressSync(p.m.baseMint, p.depositor, true),
        fromQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.depositor, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async cancel(p: { mandate: PublicKey; m: any }) {
    return this.program.methods
      .cancel()
      .accountsStrict({
        issuer: p.m.issuer,
        mandate: p.mandate,
        baseVault: p.m.baseVault,
        quoteVault: p.m.quoteVault,
        feeVault: p.m.feeVault,
        issuerBase: getAssociatedTokenAddressSync(p.m.baseMint, p.m.issuer, true),
        issuerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.m.issuer, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async accept(p: { maker: PublicKey; mandate: PublicKey; m: any }) {
    return this.program.methods
      .acceptMandate()
      .accountsStrict({
        maker: p.maker,
        mandate: p.mandate,
        makerProfile: pda.makerProfile(p.maker),
        bondVault: p.m.bondVault,
        feeVault: p.m.feeVault,
        makerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.maker, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async openPosition(p: { maker: PublicKey; mandate: PublicKey; m: any; lowerBinId: number; width: number }) {
    return this.program.methods
      .openPosition(p.lowerBinId, p.width)
      .accountsStrict({
        maker: p.maker,
        mandate: p.mandate,
        lbPair: p.m.lbPair,
        position: pda.dlmmPosition(p.m.lbPair, p.mandate, p.lowerBinId, p.width),
        eventAuthority: DLMM_EVENT_AUTHORITY,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  private manageAccounts(p: { authority: PublicKey; mandate: PublicKey; m: any; pair: LbPairInfo }) {
    return {
      authority: p.authority,
      mandate: p.mandate,
      lbPair: p.m.lbPair,
      oracle: p.m.oracle,
      position: p.m.position,
      baseVault: p.m.baseVault,
      quoteVault: p.m.quoteVault,
      reserveX: p.pair.reserveX,
      reserveY: p.pair.reserveY,
      baseMint: p.m.baseMint,
      quoteMint: p.m.quoteMint,
      eventAuthority: DLMM_EVENT_AUTHORITY,
      dlmmProgram: DLMM_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  private positionBinArrays(m: any) {
    const lower = m.positionLowerBinId as number;
    const upper = lower + (m.positionWidth as number) - 1;
    return binArraysCovering(m.lbPair, lower, upper).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  }

  async addLiquidity(p: {
    authority: PublicKey;
    mandate: PublicKey;
    m: any;
    pair: LbPairInfo;
    amountBase: BN;
    amountQuote: BN;
    minBinId: number;
    maxBinId: number;
    strategy?: StrategyType;
    maxActiveBinSlippage?: number;
  }) {
    return this.program.methods
      .addLiquidity({
        amountBase: p.amountBase,
        amountQuote: p.amountQuote,
        minBinId: p.minBinId,
        maxBinId: p.maxBinId,
        strategyType: p.strategy ?? StrategyType.SpotImBalanced,
        maxActiveBinSlippage: p.maxActiveBinSlippage ?? 5,
      })
      .accountsStrict(this.manageAccounts(p))
      .remainingAccounts(this.positionBinArrays(p.m))
      .instruction();
  }

  async removeLiquidity(p: {
    authority: PublicKey;
    mandate: PublicKey;
    m: any;
    pair: LbPairInfo;
    fromBinId?: number;
    toBinId?: number;
    /** 0 with `claimFees` claims LP fees only. */
    bps?: number;
    claimFees?: boolean;
  }) {
    const lower = p.m.positionLowerBinId as number;
    const upper = lower + (p.m.positionWidth as number) - 1;
    return this.program.methods
      .removeLiquidity(p.fromBinId ?? lower, p.toBinId ?? upper, p.bps ?? 10_000, p.claimFees ?? true)
      .accountsStrict(this.manageAccounts(p))
      .remainingAccounts(this.positionBinArrays(p.m))
      .instruction();
  }

  async closePosition(p: { authority: PublicKey; mandate: PublicKey; m: any }) {
    return this.program.methods
      .closePosition()
      .accountsStrict({
        authority: p.authority,
        mandate: p.mandate,
        position: p.m.position,
        rentReceiver: p.m.positionRentPayer,
        eventAuthority: DLMM_EVENT_AUTHORITY,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .instruction();
  }

  async snapshot(p: { cranker: PublicKey; mandate: PublicKey; m: any }) {
    const hasPosition = !(p.m.position as PublicKey).equals(PublicKey.default);
    return this.program.methods
      .snapshot()
      .accountsStrict({
        cranker: p.cranker,
        mandate: p.mandate,
        scoreLog: p.m.scoreLog,
        makerProfile: pda.makerProfile(p.m.maker),
        lbPair: p.m.lbPair,
        oracle: p.m.oracle,
        referencePool: p.m.referencePool,
        position: hasPosition ? p.m.position : SystemProgram.programId,
      })
      .remainingAccounts(
        hasPosition ? this.positionBinArrays(p.m).map((a) => ({ ...a, isWritable: false })) : [],
      )
      .instruction();
  }

  async finalize(p: { mandate: PublicKey; m: any }) {
    return this.program.methods
      .finalize()
      .accountsStrict({ mandate: p.mandate, scoreLog: p.m.scoreLog, makerProfile: pda.makerProfile(p.m.maker) })
      .instruction();
  }

  async claimMakerFees(p: { mandate: PublicKey; m: any }) {
    return this.program.methods
      .claimMakerFees()
      .accountsStrict({
        maker: p.m.maker,
        mandate: p.mandate,
        feeVault: p.m.feeVault,
        makerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.m.maker, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async settle(p: { mandate: PublicKey; m: any }) {
    return this.program.methods
      .settle()
      .accountsStrict({
        mandate: p.mandate,
        baseVault: p.m.baseVault,
        quoteVault: p.m.quoteVault,
        feeVault: p.m.feeVault,
        bondVault: p.m.bondVault,
        issuerBase: getAssociatedTokenAddressSync(p.m.baseMint, p.m.issuer, true),
        issuerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.m.issuer, true),
        makerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.m.maker, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async initRouter(p: { authority: PublicKey }) {
    return this.program.methods
      .initRouter()
      .accountsStrict({ authority: p.authority, router: pda.router(p.authority), systemProgram: SystemProgram.programId })
      .instruction();
  }

  async registerLaunch(p: { authority: PublicKey; baseMint: PublicKey; mandate: PublicKey }) {
    const router = pda.router(p.authority);
    return this.program.methods
      .registerLaunch()
      .accountsStrict({
        authority: p.authority,
        router,
        baseMint: p.baseMint,
        mandate: p.mandate,
        launch: pda.launch(router, p.baseMint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async routeLeftover(p: { routerAuthority: PublicKey; mandate: PublicKey; m: any }) {
    const router = pda.router(p.routerAuthority);
    return this.program.methods
      .routeLeftover()
      .accountsStrict({
        router,
        launch: pda.launch(router, p.m.baseMint),
        mandate: p.mandate,
        routerBase: getAssociatedTokenAddressSync(p.m.baseMint, router, true),
        baseVault: p.m.baseVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  /** Once the mandate has ended, leftover supply in the router goes to the issuer. */
  async recoverLeftover(p: { routerAuthority: PublicKey; mandate: PublicKey; m: any }) {
    const router = pda.router(p.routerAuthority);
    return this.program.methods
      .recoverLeftover()
      .accountsStrict({
        router,
        launch: pda.launch(router, p.m.baseMint),
        mandate: p.mandate,
        routerBase: getAssociatedTokenAddressSync(p.m.baseMint, router, true),
        issuerBase: getAssociatedTokenAddressSync(p.m.baseMint, p.m.issuer, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  /** Return tokens that reached a settled or cancelled mandate's vaults. */
  async sweep(p: { mandate: PublicKey; m: any }) {
    const settled = !!p.m.status?.settled;
    return this.program.methods
      .sweep()
      .accountsStrict({
        mandate: p.mandate,
        baseVault: p.m.baseVault,
        quoteVault: p.m.quoteVault,
        feeVault: p.m.feeVault,
        bondVault: p.m.bondVault,
        issuerBase: getAssociatedTokenAddressSync(p.m.baseMint, p.m.issuer, true),
        issuerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, p.m.issuer, true),
        bondOwnerQuote: getAssociatedTokenAddressSync(p.m.quoteMint, settled ? p.m.maker : p.m.issuer, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  // --- decoding -------------------------------------------------------------

  decodeMandate(data: Buffer | Uint8Array): any {
    return this.program.coder.accounts.decode("mandate", Buffer.from(data));
  }
  decodeScoreLog(data: Buffer | Uint8Array): any {
    return this.program.coder.accounts.decode("scoreLog", Buffer.from(data));
  }
  decodeMakerProfile(data: Buffer | Uint8Array): any {
    return this.program.coder.accounts.decode("makerProfile", Buffer.from(data));
  }
}

// ---------------------------------------------------------------------------
// DLMM helpers (permissionless instructions used by makers / launch flows)
// ---------------------------------------------------------------------------

/** DLMM `initialize_bin_array` (permissionless; funder pays rent). */
export function dlmmInitBinArrayIx(lbPair: PublicKey, index: number, funder: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(16);
  Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).copy(data, 0);
  data.writeBigInt64LE(BigInt(index), 8);
  return new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: pda.binArray(lbPair, index), isSigner: false, isWritable: true },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** DLMM `swap2` (exact in). `xToY` sells token X for token Y. */
export function dlmmSwapIx(p: {
  lbPair: PublicKey;
  pair: LbPairInfo;
  user: PublicKey;
  userTokenIn: PublicKey;
  userTokenOut: PublicKey;
  amountIn: bigint;
  minAmountOut?: bigint;
  binArrays: PublicKey[];
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8 + 4);
  Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minAmountOut ?? 0n, 16);
  data.writeUInt32LE(0, 24); // remaining_accounts_info.slices = []
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      rw(p.lbPair), ro(DLMM_PROGRAM_ID), rw(p.pair.reserveX), rw(p.pair.reserveY), rw(p.userTokenIn), rw(p.userTokenOut),
      ro(p.pair.tokenX), ro(p.pair.tokenY), rw(p.pair.oracle), ro(DLMM_PROGRAM_ID),
      { pubkey: p.user, isSigner: true, isWritable: false },
      ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(MEMO_PROGRAM_ID), ro(DLMM_EVENT_AUTHORITY), ro(DLMM_PROGRAM_ID),
      ...p.binArrays.map(rw),
    ],
    data,
  });
}

export * from "./rpc";
export * from "./sentinel";
export * from "./systemone";
export * from "./measure";
import { measureCommitted, type CommittedResult } from "./measure";
export * from "./accounts";
export * from "./observe";
export * from "./report";
export * from "./draft";
export * from "./renewal";
