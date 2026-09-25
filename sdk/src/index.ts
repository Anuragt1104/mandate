/**
 * Mandate TypeScript client: PDA derivation, instruction builders and account decoding.
 * Shared by tests, the keeper/maker bots and the web app.
 */
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const MANDATE_PROGRAM_ID = new PublicKey("3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
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
  maxRefDeviationBps: number;
  minSnapshotIntervalSecs: number;
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
      referencePool: p.m.referencePool,
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
