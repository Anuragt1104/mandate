/**
 * Two different questions about a maker's book, kept apart on purpose:
 *
 *  - measureCommitted(): what the Mandate program enforces. An exact mirror of
 *    programs/mandate/src/scoring.rs on raw account data: Q64.64 bin prices computed the
 *    way math.rs computes them, each bin valued before the ownership share is applied, the
 *    same rounding, saturation and window. Its result is the program's result (tested
 *    against the program on real DLMM accounts in tests/lifecycle.test.ts). Trading against
 *    the book does not change it: nobody can fail a compliant maker by buying out its asks.
 *    When an input is missing it says "unknown" rather than guessing a result.
 *  - executable(): an estimate of what a trader would get right now, walking the book's
 *    current token composition in floating point. It moves with every trade, which is
 *    exactly why it isn't enforced; use it for display only.
 *
 * An SLA can pass while execution is poor (a side was just drained and not yet refilled);
 * showing both keeps the agreement honest about what it guarantees.
 */

// ---------------------------------------------------------------- canonical (enforced)

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const ONE = 1n << 64n;
const BPS = 10_000n;
const MAX_EXPONENTIAL = 0x80000;
const BINS_PER_ARRAY = 70;
const SPREAD_SIZE_DIVISOR = 10n;
export const EMPTY_SIDE = 65535;

class MathOverflow extends Error {}
const mulU128 = (a: bigint, b: bigint) => {
  const r = a * b;
  if (r > U128_MAX) throw new MathOverflow();
  return r;
};

/** math.rs pow_q64: base^exp in Q64.64, inverting when base >= 1 so intermediates stay below 2^128. */
export function powQ64(base: bigint, exp: number): bigint | null {
  if (exp === 0) return ONE;
  let invert = exp < 0;
  const e = Math.abs(exp);
  if (e >= MAX_EXPONENTIAL) return null;
  let squared = base;
  try {
    if (squared >= ONE) {
      if (squared === 0n) return null;
      squared = U128_MAX / squared;
      invert = !invert;
    }
    let result = ONE;
    for (let bit = 0; 1 << bit <= e; bit++) {
      if (e & (1 << bit)) result = mulU128(result, squared) >> 64n;
      squared = mulU128(squared, squared) >> 64n;
    }
    if (result === 0n) return null;
    if (invert) result = U128_MAX / result;
    return result;
  } catch (e) {
    if (e instanceof MathOverflow) return null;
    throw e;
  }
}

/** math.rs price_from_bin_id: (1 + bin_step / 10_000)^bin_id in Q64.64. */
export function priceQ64(binId: number, binStep: number): bigint | null {
  const bps = (BigInt(binStep) << 64n) / BPS;
  return powQ64(ONE + bps, binId);
}

/** math.rs base_to_quote: (amount × price) >> 64, saturating at u64::MAX. */
function baseToQuote(amount: bigint, priceQ64: bigint): bigint {
  const v = (amount * priceQ64) >> 64n;
  return v > U64_MAX ? U64_MAX : v;
}

/** math.rs mul_div: a × b / d rounded down, None above u128. */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  const n = a * b;
  if (n > U256_MAX) return null;
  const r = n / d;
  return r > U128_MAX ? null : r;
}

/** math.rs bin_array_index: floor(bin / 70). */
export function binArrayIndexOf(bin: number): number {
  return Math.floor(bin / BINS_PER_ARRAY);
}

export interface RawBin {
  amountX: bigint;
  amountY: bigint;
  liquiditySupply: bigint;
}

export interface RawTerms {
  minDepthQuote: bigint;
  depthWindowBps: number;
  maxSpreadBps: number;
}

export interface MeasureInput {
  anchorBin: number;
  binStep: number;
  /** The mandate position's range and per-bin liquidity shares; null when none is open. */
  position: { lower: number; upper: number; shares: bigint[] } | null;
  /** The 70 bins of bin array `index`, or undefined when it wasn't supplied. */
  binArray: (index: number) => RawBin[] | undefined;
  terms: RawTerms;
}

export type CommittedResult =
  | { status: "measured"; ok: boolean; bidDepth: bigint; askDepth: bigint; spreadBps: number }
  /** An input the program would need is missing (it would reject the snapshot): no verdict. */
  | { status: "unknown"; reason: string };

/**
 * One bin's committed value for a position (scoring.rs `committed`): the bin valued at its own
 * price, then the position's share of it. A string explains why it can't be computed.
 */
export function binCommitted(bin: number, pos: { lower: number; upper: number; shares: bigint[] }, binArray: (index: number) => RawBin[] | undefined, binStep: number): bigint | string {
  if (bin < pos.lower || bin > pos.upper) return 0n;
  const share = pos.shares[bin - pos.lower] ?? 0n;
  if (share === 0n) return 0n;
  const idx = binArrayIndexOf(bin);
  const arr = binArray(idx);
  if (!arr) return `bin array ${idx} was not read`;
  const b = arr[bin - idx * BINS_PER_ARRAY];
  if (!b) return "bin outside its array";
  if (b.liquiditySupply === 0n) return 0n;
  const p = priceQ64(bin, Math.max(1, binStep));
  if (p === null) return "price overflow";
  const value = baseToQuote(b.amountX, p) + b.amountY;
  const mine = mulDiv(value, share, b.liquiditySupply);
  if (mine === null) return "value overflow";
  return mine > U64_MAX ? U64_MAX : mine;
}

/**
 * scoring.rs summation over per-bin committed values: the reference bin and the whole bins
 * within the window below it are bids, the whole bins within the window above it are asks,
 * and the spread is measured at a tenth of the minimum depth. `value` may combine several
 * positions (their per-bin values add); a string from it makes the result unknown.
 */
export function scoreCommitted(value: (bin: number) => bigint | string, anchor: number, binStep: number, terms: RawTerms, hasPosition = true): CommittedResult {
  const step = Math.max(1, binStep);
  const windowBins = Math.floor(terms.depthWindowBps / step);
  let size = terms.minDepthQuote / SPREAD_SIZE_DIVISOR;
  if (size < 1n) size = 1n;
  let bidDepth = 0n;
  let askDepth = 0n;
  let bidAt: number | null = null;
  let askAt: number | null = null;
  if (hasPosition) {
    const sat = (a: bigint, b: bigint) => (a + b > U64_MAX ? U64_MAX : a + b);
    for (let k = 0; k <= windowBins; k++) {
      const v = value(anchor - k);
      if (typeof v === "string") return { status: "unknown", reason: v };
      bidDepth = sat(bidDepth, v);
      if (bidAt === null && bidDepth >= size) bidAt = anchor - k;
    }
    for (let k = 1; k <= windowBins; k++) {
      const v = value(anchor + k);
      if (typeof v === "string") return { status: "unknown", reason: v };
      askDepth = sat(askDepth, v);
      if (askAt === null && askDepth >= size) askAt = anchor + k;
    }
  }
  const spreadBps = bidAt !== null && askAt !== null ? Math.min((askAt - bidAt) * step, EMPTY_SIDE) : EMPTY_SIDE;
  const ok = hasPosition && spreadBps <= terms.maxSpreadBps && bidDepth >= terms.minDepthQuote && askDepth >= terms.minDepthQuote;
  return { status: "measured", ok, bidDepth, askDepth, spreadBps };
}

/** scoring.rs measure(), exactly: raw quote atoms in, the program's verdict out. */
export function measureCommitted(input: MeasureInput): CommittedResult {
  const pos = input.position;
  return scoreCommitted((bin) => (pos ? binCommitted(bin, pos, input.binArray, input.binStep) : 0n), input.anchorBin, input.binStep, input.terms, !!pos);
}

// ---------------------------------------------------------------- estimate (shown only)

export interface Bin {
  binId: number;
  /** Base tokens in the bin (UI units). */
  base: number;
  /** Quote tokens in the bin (UI units). */
  quote: number;
  /** Price of one base token in quote at this bin (UI units). */
  price: number;
}

export interface Fill {
  /** Quote in (buy) or quote out (sell), UI units. */
  size: number;
  /** Fraction of the requested size the book could fill. */
  filled: number;
  /** Average execution price vs the reference price: +0.012 = paid 1.2% above (buy), received 1.2% below (sell) as a positive cost. */
  cost: number | null;
}

/**
 * Walk the current book for a buy (spend `size` quote on asks from the active bin up) and a
 * sell (sell base worth `size` quote into bids from the active bin down), before swap fees.
 * A floating-point estimate for display, never a compliance result.
 */
export function executable(bins: Bin[], activeBin: number, referencePrice: number, size: number): { buy: Fill; sell: Fill } {
  const asks = bins.filter((b) => b.base > 0 && b.binId >= activeBin).sort((a, b) => a.binId - b.binId);
  const bids = bins.filter((b) => b.quote > 0 && b.binId <= activeBin).sort((a, b) => b.binId - a.binId);

  let spend = size;
  let got = 0;
  for (const b of asks) {
    const cost = b.base * b.price;
    if (cost >= spend) {
      got += spend / b.price;
      spend = 0;
      break;
    }
    got += b.base;
    spend -= cost;
  }
  const spent = size - spend;
  const buy: Fill = { size, filled: spent / size, cost: got > 0 ? spent / got / referencePrice - 1 : null };

  let toSell = size / referencePrice;
  let received = 0;
  const startBase = toSell;
  for (const b of bids) {
    const capacity = b.quote / b.price;
    if (capacity >= toSell) {
      received += toSell * b.price;
      toSell = 0;
      break;
    }
    received += b.quote;
    toSell -= capacity;
  }
  const sold = startBase - toSell;
  const sell: Fill = { size, filled: sold / startBase, cost: sold > 0 ? 1 - received / sold / referencePrice : null };
  return { buy, sell };
}
