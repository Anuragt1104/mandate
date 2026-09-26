/**
 * Two different questions about a maker's book, kept apart on purpose:
 *
 *  - committed(): what the Mandate program enforces (a mirror of programs/mandate/src/
 *    scoring.rs). Each bin is valued at its own price, so trading against the book does not
 *    change the result: nobody can fail a compliant maker by buying out its asks.
 *  - executable(): what a trader would actually get right now, walking the book's current
 *    token composition. This moves with every trade, which is exactly why it isn't enforced.
 *
 * An SLA can pass while execution is poor (a side was just drained and not yet refilled);
 * showing both keeps the agreement honest about what it guarantees.
 */

export interface Bin {
  binId: number;
  /** Base tokens in the bin (UI units). */
  base: number;
  /** Quote tokens in the bin (UI units). */
  quote: number;
  /** Price of one base token in quote at this bin (UI units). */
  price: number;
}

export interface CommitTerms {
  minDepth: number; // quote, UI units
  windowBps: number;
  maxSpreadBps: number;
}

export interface Committed {
  ok: boolean;
  bidDepth: number;
  askDepth: number;
  /** Spread at size (min depth / 10) in bps; null when a side can't reach that size. */
  spreadBps: number | null;
}

/** The program's measurement: committed value around the reference bin. */
export function committed(bins: Bin[], referenceBin: number, binStep: number, t: CommitTerms): Committed {
  const byId = new Map(bins.map((b) => [b.binId, b]));
  const value = (id: number) => {
    const b = byId.get(id);
    return b ? b.base * b.price + b.quote : 0;
  };
  const windowBins = Math.ceil(t.windowBps / Math.max(1, binStep));
  const size = t.minDepth / 10;
  let bidDepth = 0;
  let askDepth = 0;
  let bidAt: number | null = null;
  let askAt: number | null = null;
  for (let k = 0; k <= windowBins; k++) {
    bidDepth += value(referenceBin - k);
    if (bidAt === null && bidDepth >= size) bidAt = referenceBin - k;
    askDepth += value(referenceBin + 1 + k);
    if (askAt === null && askDepth >= size) askAt = referenceBin + 1 + k;
  }
  const spreadBps = bidAt !== null && askAt !== null ? (askAt - bidAt) * binStep : null;
  const ok = bins.length > 0 && spreadBps !== null && spreadBps <= t.maxSpreadBps && bidDepth >= t.minDepth && askDepth >= t.minDepth;
  return { ok, bidDepth, askDepth, spreadBps };
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
