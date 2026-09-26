/**
 * What an observation session says about a set of terms.
 *
 *  - evaluate(): a historical replay. Every sample's exact per-bin committed values are
 *    scored against the terms with the program's arithmetic; periods are met, missed,
 *    unknown (evidence incomplete) or unobserved. Nothing here predicts anything.
 *  - forecastMoves(): a what-if, kept separate and labelled as such: if the reference moved
 *    by X% and the operator did nothing, would the latest observed book still pass, and how
 *    soon could the reference get there at the agreed speed limit?
 *  - readiness: whether there is enough evidence to interpret the replay, and what is missing.
 *  - suggestTerms(): terms the observed book would have met most of the time, as a starting
 *    point for a negotiation, not a recommendation.
 *  - encodeShared()/decodeShared(): a compact, link-sized summary anyone can open.
 */
import { executable, scoreCommitted, EMPTY_SIDE, type Bin } from "./measure";
import type { Sample, Session } from "./observe";

export interface EvalTerms {
  /** Minimum committed depth per side, quote UI units. */
  minDepth: number;
  depthWindowBps: number;
  maxSpreadBps: number;
}

export type CheckResult = "met" | "missed" | "unknown";
export type PeriodVerdict = CheckResult | "unobserved";

export interface CheckEval {
  at: number;
  result: CheckResult;
  reason?: string;
  bid?: number;
  ask?: number;
  spreadBps?: number;
  failed?: ("bids" | "asks" | "spread")[];
}

export interface PeriodEval {
  index: number;
  start: number;
  verdict: PeriodVerdict;
  checks: CheckEval[];
  minBid: number | null;
  minAsk: number | null;
  worstSpread: number | null;
}

export interface Readiness {
  ready: boolean;
  /** 0..1 toward the minimum evidence for interpreting the report. */
  progress: number;
  /** Plain sentences: what is still needed before the replay can be read. */
  needs: string[];
  /** Plain sentences: evidence that is missing or incomplete (shown even when ready). */
  missing: string[];
}

export interface ExecutionStat {
  size: number;
  buyMedian: number | null;
  buyWorst: number | null;
  sellMedian: number | null;
  sellWorst: number | null;
  /** Measured samples where the book couldn't fill the size on at least one side. */
  unfilled: number;
  samples: number;
}

export interface Evaluation {
  terms: EvalTerms;
  periods: PeriodEval[];
  summary: { met: number; missed: number; unknown: number; unobserved: number; decided: number; longestMissRun: number; samples: number; measured: number };
  /** Measured checks that failed each threshold. */
  failures: { bids: number; asks: number; spread: number };
  /** Observed committed depth and spread over measured samples. */
  observed: { bidP10: number | null; askP10: number | null; bidMedian: number | null; askMedian: number | null; spreadMedian: number | null; spreadP90: number | null };
  execution: ExecutionStat[];
  readiness: Readiness;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** Score one sample against terms (exact), with the reference it had. */
export function scoreSample(s: Session, sample: Sample, t: EvalTerms, refBin = sample.reference.bin): CheckEval {
  if (sample.problem) return { at: sample.at, result: "unknown", reason: sample.problem };
  if (refBin === undefined) return { at: sample.at, result: "unknown", reason: "the reference price was still warming up" };
  const values = new Map(sample.bins.map(([bin, v]) => [bin, BigInt(v)]));
  const unknown = new Set(sample.unknownBins);
  const q = 10 ** s.pairFacts.quoteDecimals;
  const r = scoreCommitted((bin) => (unknown.has(bin) ? `bin ${bin} could not be read` : values.get(bin) ?? 0n), refBin, s.pairFacts.binStep, {
    minDepthQuote: BigInt(Math.round(t.minDepth * q)),
    depthWindowBps: t.depthWindowBps,
    maxSpreadBps: t.maxSpreadBps,
  });
  if (r.status === "unknown") return { at: sample.at, result: "unknown", reason: r.reason };
  const bid = Number(r.bidDepth) / q;
  const ask = Number(r.askDepth) / q;
  const failed: CheckEval["failed"] = [];
  if (bid < t.minDepth) failed.push("bids");
  if (ask < t.minDepth) failed.push("asks");
  if (r.spreadBps > t.maxSpreadBps) failed.push("spread");
  return { at: sample.at, result: r.ok ? "met" : "missed", bid, ask, spreadBps: r.spreadBps, failed };
}

/** The sample's book in UI units, for execution estimates. */
export function sampleBook(s: Session, sample: Sample): Bin[] {
  const bd = s.pairFacts.baseDecimals;
  const qd = s.pairFacts.quoteDecimals;
  return sample.bins.map(([bin, , x, y]) => ({
    binId: bin,
    base: Number(x) / 10 ** bd,
    quote: Number(y) / 10 ** qd,
    price: Math.pow(1 + s.pairFacts.binStep / 10_000, bin) * 10 ** (bd - qd),
  }));
}

export interface EvaluateOptions {
  tradeSizes?: number[];
  /** Decided periods needed before the report can be interpreted (default 12). */
  minPeriods?: number;
  /** Evaluate up to this time (default: now). */
  until?: number;
}

export function evaluate(s: Session, t: EvalTerms, o: EvaluateOptions = {}): Evaluation {
  const until = o.until ?? Math.floor(Date.now() / 1000);
  const minPeriods = o.minPeriods ?? 12;
  const nPeriods = Math.max(1, Math.ceil((Math.max(until, s.samples[s.samples.length - 1]?.at ?? 0) - s.startedAt) / s.periodSecs));
  const periods: PeriodEval[] = Array.from({ length: nPeriods }, (_, index) => ({ index, start: s.startedAt + index * s.periodSecs, verdict: "unobserved", checks: [], minBid: null, minAsk: null, worstSpread: null }));
  const failures = { bids: 0, asks: 0, spread: 0 };
  const bids: number[] = [];
  const asks: number[] = [];
  const spreads: number[] = [];
  let measured = 0;
  for (const sample of s.samples) {
    const c = scoreSample(s, sample, t);
    const p = periods[Math.min(periods.length - 1, Math.floor((sample.at - s.startedAt) / s.periodSecs))];
    p.checks.push(c);
    if (c.result === "unknown") continue;
    measured++;
    bids.push(c.bid!);
    asks.push(c.ask!);
    if (c.spreadBps! < EMPTY_SIDE) spreads.push(c.spreadBps!);
    for (const f of c.failed ?? []) failures[f]++;
    p.minBid = Math.min(p.minBid ?? Infinity, c.bid!);
    p.minAsk = Math.min(p.minAsk ?? Infinity, c.ask!);
    p.worstSpread = Math.max(p.worstSpread ?? 0, c.spreadBps!);
  }
  for (const p of periods) {
    if (!p.checks.length) continue;
    p.verdict = p.checks.some((c) => c.result === "missed") ? "missed" : p.checks.some((c) => c.result === "unknown") ? "unknown" : "met";
  }
  // A period still in progress with no sample yet isn't "unobserved"; leave it out of the counts.
  const last = periods[periods.length - 1];
  const stillOpen = last.start + s.periodSecs > until && !last.checks.length;
  const closed = stillOpen ? periods.slice(0, -1) : periods;
  const count = (v: PeriodVerdict) => closed.filter((p) => p.verdict === v).length;
  let run = 0;
  let longestMissRun = 0;
  for (const p of periods) {
    run = p.verdict === "missed" ? run + 1 : p.verdict === "met" ? 0 : run;
    longestMissRun = Math.max(longestMissRun, run);
  }

  const execution = (o.tradeSizes ?? []).map((size) => {
    const buys: number[] = [];
    const sells: number[] = [];
    let unfilled = 0;
    let n = 0;
    for (const sample of s.samples) {
      if (sample.problem || sample.reference.bin === undefined) continue;
      n++;
      const refPrice = Math.pow(1 + s.pairFacts.binStep / 10_000, sample.reference.bin) * 10 ** (s.pairFacts.baseDecimals - s.pairFacts.quoteDecimals);
      const ex = executable(sampleBook(s, sample), sample.activeBin, refPrice, size);
      if (ex.buy.cost !== null) buys.push(ex.buy.cost);
      if (ex.sell.cost !== null) sells.push(ex.sell.cost);
      if (ex.buy.filled < 0.999 || ex.sell.filled < 0.999) unfilled++;
    }
    return { size, buyMedian: quantile(buys, 0.5), buyWorst: buys.length ? Math.max(...buys) : null, sellMedian: quantile(sells, 0.5), sellWorst: sells.length ? Math.max(...sells) : null, unfilled, samples: n };
  });

  const summary = { met: count("met"), missed: count("missed"), unknown: count("unknown"), unobserved: count("unobserved"), decided: count("met") + count("missed"), longestMissRun, samples: s.samples.length, measured };
  return {
    terms: t,
    periods,
    summary,
    failures,
    observed: { bidP10: quantile(bids, 0.1), askP10: quantile(asks, 0.1), bidMedian: quantile(bids, 0.5), askMedian: quantile(asks, 0.5), spreadMedian: quantile(spreads, 0.5), spreadP90: quantile(spreads, 0.9) },
    execution,
    readiness: readiness(s, summary, closed.length, minPeriods),
  };
}

function readiness(s: Session, sum: Evaluation["summary"], closedPeriods: number, minPeriods: number): Readiness {
  const needs: string[] = [];
  const missing: string[] = [];
  const warming = s.samples.filter((x) => x.reference.state === "warming").length;
  const problems = new Map<string, number>();
  for (const x of s.samples) if (x.problem) problems.set(x.problem, (problems.get(x.problem) ?? 0) + 1);
  const partial = s.samples.filter((x) => !x.problem && x.unknownBins.length).length;
  const observedShare = closedPeriods ? (closedPeriods - sum.unobserved) / closedPeriods : 0;

  if (sum.decided < minPeriods) needs.push(`${minPeriods - sum.decided} more period${minPeriods - sum.decided === 1 ? "" : "s"} with a usable check (${sum.decided} of ${minPeriods} so far).`);
  if (closedPeriods >= 4 && observedShare < 0.75) needs.push(`Only ${Math.round(observedShare * 100)}% of periods have a sample; at least 75% are needed to speak for the whole span.`);
  if (sum.unobserved) missing.push(`${sum.unobserved} period${sum.unobserved === 1 ? "" : "s"} without any sample (observation paused, or reads failed). They count neither way.`);
  if (warming) missing.push(`${warming} sample${warming === 1 ? "" : "s"} taken before the reference price had a full ${Math.round(s.twapSecs / 60)}-minute window.`);
  for (const [why, n] of problems) missing.push(`${n} sample${n === 1 ? "" : "s"}: ${why}.`);
  if (partial) missing.push(`${partial} sample${partial === 1 ? "" : "s"} with bins that couldn't be read.`);
  if (s.samples.length && sum.measured === 0 && !warming) needs.push("No sample could be measured yet; see the missing evidence.");
  const progress = Math.min(1, sum.decided / minPeriods) * (closedPeriods >= 4 ? Math.min(1, observedShare / 0.75) : 1);
  return { ready: needs.length === 0, progress, needs, missing };
}

// ---------------------------------------------------------------- what-if (not a replay)

export interface MoveForecast {
  movePct: number;
  /** Bins the reference would move. */
  bins: number;
  passes: boolean | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  /** Fastest the reference could get there at the agreed speed limit, in minutes. */
  minutesAtSpeedLimit: number | null;
}

/**
 * If the reference moved by each percentage and the operator did nothing, would the latest
 * measured book still meet the terms? A what-if on one snapshot, not a prediction.
 */
export function forecastMoves(s: Session, t: EvalTerms, speedPctPerMin: number | null, moves = [-10, -5, -3, -1, 1, 3, 5, 10]): { basedOn: number | null; rows: MoveForecast[] } {
  const latest = [...s.samples].reverse().find((x) => !x.problem && x.reference.bin !== undefined && !x.unknownBins.length);
  if (!latest) return { basedOn: null, rows: [] };
  const step = s.pairFacts.binStep;
  return {
    basedOn: latest.at,
    rows: moves.map((m) => {
      const bins = Math.round(Math.log(1 + m / 100) / Math.log(1 + step / 10_000));
      const c = scoreSample(s, latest, t, latest.reference.bin! + bins);
      return {
        movePct: m,
        bins,
        passes: c.result === "unknown" ? null : c.result === "met",
        bid: c.bid ?? null,
        ask: c.ask ?? null,
        spreadBps: c.spreadBps ?? null,
        minutesAtSpeedLimit: speedPctPerMin ? Math.abs(m) / speedPctPerMin : null,
      };
    }),
  };
}

// ---------------------------------------------------------------- suggestions

const niceDown = (x: number) => {
  if (x <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
};

/**
 * Terms the observed book met in most samples: depth near the lower tenth of what was
 * committed, spread near the widest tenth, window as given. A starting point for talking to
 * the operator, labelled as derived from observation.
 */
export function suggestTerms(s: Session, window: number): { terms: EvalTerms; basis: string } | null {
  const e = evaluate(s, { minDepth: 0, depthWindowBps: window, maxSpreadBps: EMPTY_SIDE });
  if (!e.summary.measured) return null;
  const depth = niceDown(Math.min(e.observed.bidP10 ?? 0, e.observed.askP10 ?? 0));
  const step = s.pairFacts.binStep;
  const spread = Math.max(step, Math.ceil((e.observed.spreadP90 ?? step) / step) * step);
  return {
    terms: { minDepth: depth, depthWindowBps: window, maxSpreadBps: spread },
    basis: `From ${e.summary.measured} measured samples: the operator kept at least ${depth.toLocaleString("en-US")} of committed depth each side in 9 of 10 samples, and a spread of ${spread} bps or less in 9 of 10.`,
  };
}

/** Compare several term sets on the same observations (replay only). */
export function compareTerms(s: Session, options: EvalTerms[], o: EvaluateOptions = {}) {
  return options.map((t) => evaluate(s, t, o));
}

// ---------------------------------------------------------------- sharing

export interface SharedReport {
  kind: "mandate-report";
  v: 1;
  cluster: string;
  pair: string;
  owner: string | null;
  operatorName?: string;
  symbols: { base?: string; quote?: string };
  binStep: number;
  startedAt: number;
  endedAt: number;
  periodSecs: number;
  terms: EvalTerms;
  /** One character per period: m met, x missed, u unknown, - unobserved. */
  periods: string;
  summary: Evaluation["summary"];
  failures: Evaluation["failures"];
  observed: Evaluation["observed"];
  execution: ExecutionStat[];
  readiness: Readiness;
  suggested?: { terms: EvalTerms; basis: string } | null;
}

export function shareable(s: Session, e: Evaluation): SharedReport {
  const code = { met: "m", missed: "x", unknown: "u", unobserved: "-" } as const;
  return {
    kind: "mandate-report",
    v: 1,
    cluster: s.cluster,
    pair: s.pair,
    owner: s.owner,
    operatorName: s.operatorName,
    symbols: { base: s.pairFacts.baseSymbol, quote: s.pairFacts.quoteSymbol },
    binStep: s.pairFacts.binStep,
    startedAt: s.startedAt,
    endedAt: s.samples[s.samples.length - 1]?.at ?? s.startedAt,
    periodSecs: s.periodSecs,
    terms: e.terms,
    periods: e.periods.map((p) => code[p.verdict]).join(""),
    summary: e.summary,
    failures: e.failures,
    observed: e.observed,
    execution: e.execution,
    readiness: e.readiness,
    suggested: suggestTerms(s, e.terms.depthWindowBps),
  };
}

const b64url = (b: Uint8Array) => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (t: string) => {
  const s = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** JSON → deflate → base64url: small enough for a link fragment. */
export async function packLink(value: unknown): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("deflate-raw")));
}

export async function unpackLink<T>(packed: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await pipe(unb64url(packed), new DecompressionStream("deflate-raw")))) as T;
}
