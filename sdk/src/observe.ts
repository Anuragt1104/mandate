/**
 * Observing an existing liquidity arrangement, read-only: no escrow, no program, no keys.
 *
 * A session samples an operator's Meteora DLMM position(s) on a pair at random times and
 * keeps, for each sample, the exact committed value of every bin (the Mandate program's own
 * arithmetic, measure.ts) plus the bin's token composition. Because the raw per-bin evidence
 * is kept, the same observations can later be scored against any proposed terms (report.ts):
 * "would this agreement have passed?" is a replay, not a guess.
 *
 * The reference price is the pair's own DLMM oracle TWAP, as in the program: the oracle is
 * sampled in the background, and a sample only has a reference once oracle observations span
 * the TWAP window ("warming" until then). With no trade in the whole window the oracle
 * doesn't move and the reference is the active bin ("quiet"). There is no speed limit here.
 *
 * Positions are validated (DLMM-owned PositionV2 on this pair, owned by the operator). What
 * can't be measured exactly (extended positions, unread bin arrays) is recorded as missing
 * evidence, never as a failure.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { loadAccounts } from "./accounts";
import { binCommitted, type RawBin } from "./measure";

export const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const POSITION_V2 = [117, 176, 212, 199, 245, 180, 133, 182];

export type RefState = "ready" | "quiet" | "warming";

/** One observation: [bin, committed value, base, quote], all in atoms as decimal strings. */
export type ObservedBin = [number, string, string, string];

export interface Sample {
  at: number;
  slot: number;
  reference: { state: RefState; bin?: number; from?: number; to?: number };
  activeBin: number;
  positions: string[];
  /** Why nothing could be measured at this sample (no position, unsupported layout…). */
  problem?: string;
  bins: ObservedBin[];
  /** Bins the operator holds whose bin array couldn't be read. */
  unknownBins: number[];
}

export interface PairFacts {
  binStep: number;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  oracle: string;
  baseSymbol?: string;
  quoteSymbol?: string;
}

export interface Session {
  kind: "mandate-observation";
  version: 1;
  id: string;
  cluster: string;
  pair: string;
  owner: string | null;
  position: string | null;
  /** Human label for the operator, if known. */
  operatorName?: string;
  /** The terms the session was started to check (any others can be replayed later). */
  terms?: { minDepth: number; depthWindowBps: number; maxSpreadBps: number };
  startedAt: number;
  periodSecs: number;
  checksPerPeriod: number;
  twapSecs: number;
  pairFacts: PairFacts;
  /** Recent oracle observations (bounded), for the reference. */
  oracle: { ts: number; cumulative: string }[];
  /** When the oracle was first sampled: "quiet" needs a full window of sampling. */
  oracleSince: number;
  samples: Sample[];
}

// ---------------------------------------------------------------- decoding (DLMM layouts)

function readLbPair(d: Buffer) {
  return {
    activeId: d.readInt32LE(76),
    binStep: d.readUInt16LE(80),
    tokenX: new PublicKey(d.subarray(88, 120)),
    tokenY: new PublicKey(d.subarray(120, 152)),
    oracle: new PublicKey(d.subarray(552, 584)),
  };
}

function readPosition(d: Buffer) {
  const shares: bigint[] = [];
  for (let i = 0; i < 70; i++) shares.push(d.readBigUInt64LE(72 + i * 16) + (d.readBigUInt64LE(80 + i * 16) << 64n));
  return { lbPair: new PublicKey(d.subarray(8, 40)), owner: new PublicKey(d.subarray(40, 72)), lower: d.readInt32LE(7912), upper: d.readInt32LE(7916), shares };
}

function readBinArray(d: Buffer): { index: number; bins: RawBin[] } {
  const bins: RawBin[] = [];
  for (let i = 0; i < 70; i++) {
    const o = 56 + i * 144;
    bins.push({ amountX: d.readBigUInt64LE(o), amountY: d.readBigUInt64LE(o + 8), liquiditySupply: d.readBigUInt64LE(o + 32) + (d.readBigUInt64LE(o + 40) << 64n) });
  }
  return { index: Number(d.readBigInt64LE(8)), bins };
}

function readOracleLatest(d: Buffer): { cumulative: bigint; ts: number } | null {
  const idx = Number(d.readBigUInt64LE(8));
  if (d.readBigUInt64LE(16) === 0n) return null;
  const o = 32 + idx * 32;
  return { cumulative: (d.readBigInt64LE(o + 8) << 64n) + d.readBigUInt64LE(o), ts: Number(d.readBigInt64LE(o + 24)) };
}

const binArrayKey = (pair: PublicKey, index: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), pair.toBuffer(), b], DLMM_PROGRAM)[0];
};

const isPositionV2 = (d: Buffer) => POSITION_V2.every((b, i) => d[i] === b);

// ---------------------------------------------------------------- discovery

export interface Operator {
  owner: string;
  positions: string[];
}

/** Everyone holding a DLMM PositionV2 on `pair`, largest holders of positions first. */
export async function findOperators(conn: Connection, pair: PublicKey): Promise<Operator[]> {
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM, {
    filters: [{ memcmp: { offset: 8, bytes: pair.toBase58() } }],
    dataSlice: { offset: 0, length: 72 },
  });
  const by = new Map<string, string[]>();
  for (const a of accs) {
    const d = Buffer.from(a.account.data);
    if (!isPositionV2(d)) continue;
    const owner = new PublicKey(d.subarray(40, 72)).toBase58();
    by.set(owner, [...(by.get(owner) ?? []), a.pubkey.toBase58()]);
  }
  return [...by].map(([owner, positions]) => ({ owner, positions })).sort((a, b) => b.positions.length - a.positions.length);
}

/** A position address: its pair and owner, if it is a DLMM PositionV2. */
export async function resolvePosition(conn: Connection, position: PublicKey): Promise<{ pair: string; owner: string } | null> {
  const info = await conn.getAccountInfo(position);
  if (!info || !info.owner.equals(DLMM_PROGRAM) || !isPositionV2(Buffer.from(info.data))) return null;
  const p = readPosition(Buffer.from(info.data));
  return { pair: p.lbPair.toBase58(), owner: p.owner.toBase58() };
}

// ---------------------------------------------------------------- session

export async function newSession(
  conn: Connection,
  o: { cluster: string; pair: PublicKey; owner?: PublicKey | null; position?: PublicKey | null; periodSecs: number; checksPerPeriod?: number; twapSecs?: number; operatorName?: string; symbols?: { base?: string; quote?: string }; terms?: Session["terms"] },
): Promise<Session> {
  const info = await conn.getAccountInfo(o.pair);
  if (!info || !info.owner.equals(DLMM_PROGRAM)) throw new Error("That address is not a Meteora DLMM pair.");
  const pair = readLbPair(Buffer.from(info.data));
  const { infos } = await loadAccounts(conn, [pair.tokenX, pair.tokenY]);
  if (!infos[0] || !infos[1]) throw new Error("Could not read the pair's token mints.");
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: "mandate-observation",
    version: 1,
    id: `${o.pair.toBase58().slice(0, 6)}-${now.toString(36)}`,
    cluster: o.cluster,
    pair: o.pair.toBase58(),
    owner: o.owner?.toBase58() ?? null,
    position: o.position?.toBase58() ?? null,
    operatorName: o.operatorName,
    terms: o.terms,
    startedAt: now,
    periodSecs: o.periodSecs,
    checksPerPeriod: o.checksPerPeriod ?? 3,
    twapSecs: o.twapSecs ?? 300,
    pairFacts: {
      binStep: pair.binStep,
      baseMint: pair.tokenX.toBase58(),
      quoteMint: pair.tokenY.toBase58(),
      baseDecimals: infos[0].data[44],
      quoteDecimals: infos[1].data[44],
      oracle: pair.oracle.toBase58(),
      baseSymbol: o.symbols?.base,
      quoteSymbol: o.symbols?.quote,
    },
    oracle: [],
    oracleSince: 0,
    samples: [],
  };
}

/** Record the pair oracle's latest observation (call every ~15 s while observing). */
export async function sampleOracle(conn: Connection, s: Session, now = Math.floor(Date.now() / 1000)) {
  const info = await conn.getAccountInfo(new PublicKey(s.pairFacts.oracle)).catch(() => null);
  const o = info ? readOracleLatest(Buffer.from(info.data)) : null;
  if (!o) return;
  s.oracleSince ||= now;
  const last = s.oracle[s.oracle.length - 1];
  if (!last || o.ts > last.ts) s.oracle.push({ ts: o.ts, cumulative: o.cumulative.toString() });
  while (s.oracle.length > 2 && s.oracle[1].ts < now - 4 * s.twapSecs) s.oracle.shift();
}

/** TWAP bin over at least the TWAP window, ending at the latest oracle observation. */
export function referenceNow(s: Session, activeBin: number, now: number): Sample["reference"] {
  const last = s.oracle[s.oracle.length - 1];
  if (!last) return { state: "warming" };
  if (now - last.ts > s.twapSecs && s.oracleSince > 0 && s.oracleSince <= now - s.twapSecs) return { state: "quiet", bin: activeBin };
  const start = [...s.oracle].reverse().find((o) => o.ts <= last.ts - s.twapSecs);
  if (!start) return { state: "warming" };
  const span = BigInt(last.ts - start.ts);
  const d = BigInt(last.cumulative) - BigInt(start.cumulative);
  const avg = d >= 0n || d % span === 0n ? d / span : d / span - 1n;
  return { state: "ready", bin: Number(avg), from: start.ts, to: last.ts };
}

/** Take one sample of the operator's liquidity. Never throws for missing evidence; records it. */
export async function takeSample(conn: Connection, s: Session): Promise<Sample> {
  const pairKey = new PublicKey(s.pair);
  const keys = s.position
    ? [new PublicKey(s.position)]
    : (await conn.getProgramAccounts(DLMM_PROGRAM, {
        filters: [{ memcmp: { offset: 8, bytes: s.pair } }, { memcmp: { offset: 40, bytes: s.owner! } }],
        dataSlice: { offset: 0, length: 8 },
      }))
        .filter((a) => isPositionV2(Buffer.from(a.account.data)))
        .map((a) => a.pubkey);
  const first = await loadAccounts(conn, [pairKey, ...keys]);
  if (!first.infos[0]) throw new Error("pair not found");
  const pair = readLbPair(Buffer.from(first.infos[0].data));
  const at = Math.floor(Date.now() / 1000);
  const sample: Sample = { at, slot: first.slot, reference: referenceNow(s, pair.activeId, at), activeBin: pair.activeId, positions: keys.map((k) => k.toBase58()), bins: [], unknownBins: [] };
  if (!keys.length) return { ...sample, problem: "no position found for this operator on this pair" };

  const positions = [];
  for (const [i, k] of keys.entries()) {
    const info = first.infos[1 + i];
    if (!info) return { ...sample, problem: `position ${k.toBase58()} not found` };
    const d = Buffer.from(info.data);
    if (!info.owner.equals(DLMM_PROGRAM) || !isPositionV2(d)) return { ...sample, problem: `${k.toBase58()} is not a DLMM PositionV2 account` };
    const p = readPosition(d);
    if (!p.lbPair.equals(pairKey)) return { ...sample, problem: `position ${k.toBase58()} is on another pair` };
    if (s.owner && p.owner.toBase58() !== s.owner) return { ...sample, problem: `position ${k.toBase58()} is not owned by the operator` };
    if (p.upper - p.lower + 1 > 70) return { ...sample, problem: `position ${k.toBase58()} spans more than 70 bins (extended layout): not supported yet` };
    positions.push(p);
  }
  const indexes = new Set<number>();
  for (const p of positions) for (let i = Math.floor(p.lower / 70); i <= Math.floor(p.upper / 70); i++) indexes.add(i);
  const idx = [...indexes];
  const arr = await loadAccounts(conn, idx.map((i) => binArrayKey(pairKey, i)), { partial: true });
  const arrays = new Map<number, RawBin[]>();
  arr.infos.forEach((a) => {
    if (a) {
      const b = readBinArray(Buffer.from(a.data));
      arrays.set(b.index, b.bins);
    }
  });

  // Per bin, summed over the operator's positions: exact committed value and composition.
  const acc = new Map<number, [bigint, bigint, bigint]>();
  const unknown = new Set<number>();
  for (const p of positions) {
    for (let bin = p.lower; bin <= p.upper; bin++) {
      const share = p.shares[bin - p.lower];
      if (!share) continue;
      const v = binCommitted(bin, p, (i) => arrays.get(i), pair.binStep);
      if (typeof v === "string") {
        unknown.add(bin);
        continue;
      }
      const ai = Math.floor(bin / 70);
      const raw = arrays.get(ai)![bin - ai * 70];
      const x = raw.liquiditySupply ? (raw.amountX * share) / raw.liquiditySupply : 0n;
      const y = raw.liquiditySupply ? (raw.amountY * share) / raw.liquiditySupply : 0n;
      const prev = acc.get(bin) ?? [0n, 0n, 0n];
      acc.set(bin, [prev[0] + v, prev[1] + x, prev[2] + y]);
    }
  }
  sample.bins = [...acc].filter(([, [v, x, y]]) => v > 0n || x > 0n || y > 0n).sort((a, b) => a[0] - b[0]).map(([bin, [v, x, y]]) => [bin, v.toString(), x.toString(), y.toString()]);
  sample.unknownBins = [...unknown].sort((a, b) => a - b);
  sample.at = Math.floor(Date.now() / 1000);
  return sample;
}

/** Seconds until the next sample: uniform on [0, 2 × period / checks], so the operator can't predict it. */
export function nextSampleIn(s: Session, rand = Math.random) {
  return rand() * 2 * (s.periodSecs / s.checksPerPeriod);
}
