/**
 * The sentinel: a System One triage for watchtowers. Code gathers what a watchtower has
 * actually measured about an SLA and states every comparison in words (decision models are
 * weak at arithmetic). Deterministic rules set the next-check risk that drives scheduling;
 * a decision model (Jev by default) is asked only for what rules judge poorly:
 *   - diagnosis:   what the maker's situation looks like, for the status page
 *   - breach:      probability the agreement reaches its failed-period limit
 *   - noRedeploy:  probability no liquidity is verifiably placed within the next two
 *                  scoring periods (only asked while the obligations are unmet)
 *
 * The facts are limited to what is measured: committed depth per check (which trading
 * cannot change), where the reference sat at each check, the maker's verified liquidity
 * events, and whether that event history is complete. Nothing here touches enforcement.
 */
import { decide, type SystemOneConfig } from "../sdk/src/systemone";
import { SENTINEL_POLICY, type Diagnosis, type SentinelAssessment } from "../sdk/src/sentinel";

export type { Diagnosis };
export { SENTINEL_POLICY };

/** How each diagnosis is described to the decision model. */
export const DIAGNOSES: Record<Diagnosis, string | null> = {
  quoting_normally: "Both sides hold enough liquidity near the reference and the spread is tight; nothing is wrong.",
  thin_but_compliant: "The obligations are met, but one side is only a little above its minimum.",
  withdrew_liquidity: "The market maker pulled its liquidity back into escrow, so little or nothing is being quoted.",
  reference_moved: "The reference price moved and the maker has not re-centred, so less of its liquidity sits inside the measured window.",
  out_of_range: "The price moved past the whole range the maker's position covers, so none of its liquidity counts.",
  not_started: "The maker has not placed any liquidity since accepting the agreement.",
  unclear: null,
};

/** Diagnoses under which the obligations are unmet and redeployment is the question. */
const FAILING: Diagnosis[] = ["withdrew_liquidity", "reference_moved", "out_of_range", "not_started"];

export interface Measurement {
  agoSecs: number;
  ok: boolean;
  bids: number;
  asks: number;
  spreadBps: number | null; // null when a side is empty
  /** Reference bin at that check. */
  referenceBin?: number;
}

export interface Observation {
  pair: string;
  quote: string;
  terms: { minDepth: number; windowPct: number; maxSpreadBps: number; periodSecs: number; maxFailures: number; binStep?: number };
  /** Seconds since scoring started (the program's start_ts); negative during the setup window. */
  scoringAgoSecs: number;
  checks: Measurement[]; // newest first
  failedPeriodsInARow: number;
  makerActivity: { agoSecs: number; action: string }[]; // newest first, verified events only
  /** False when the event history has gaps (unread or unavailable transactions). */
  activityComplete: boolean;
  position: { open: boolean; lowerPct?: number; upperPct?: number };
  escrowIdleShare: number | null; // share of the inventory sitting idle in escrow
  record: { periodsMet: number; periodsScored: number; breaches: number; agreements: number } | null;
}

export interface Assessment extends SentinelAssessment {
  latencyMs: number;
}

// ---------------------------------------------------------------- state

const ago = (s: number) => (s < 90 ? `${Math.round(s)} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago`);
const within = (s: number) => (s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`);
const amt = (x: number, q: string) => `${Math.round(x).toLocaleString("en-US")} ${q}`;

function sideWords(v: number, min: number, q: string) {
  if (v <= 0) return `none (the minimum is ${amt(min, q)})`;
  const r = v / min;
  const rel = r < 1 ? `below the ${amt(min, q)} minimum` : r < 1.3 ? `just above the ${amt(min, q)} minimum` : r < 3 ? `comfortably above the ${amt(min, q)} minimum` : `far above the ${amt(min, q)} minimum`;
  return `${amt(v, q)}, ${rel}`;
}

function change(prev: number, now: number) {
  if (prev <= 0 && now <= 0) return "stayed empty";
  if (prev <= 0) return "went from empty to filled";
  const r = now / prev;
  return r < 0.05 ? "fell to almost nothing" : r < 0.6 ? "fell sharply" : r < 0.9 ? "fell somewhat" : r <= 1.1 ? "held steady" : r <= 1.6 ? "rose somewhat" : "rose sharply";
}

/** Reference movement between the two latest checks, in percent (null when unknown). */
function referenceMovePct(o: Observation): number | null {
  const [last, prev] = o.checks;
  if (!last || !prev || last.referenceBin === undefined || prev.referenceBin === undefined || !o.terms.binStep) return null;
  return (Math.pow(1 + o.terms.binStep / 10_000, last.referenceBin - prev.referenceBin) - 1) * 100;
}

/** What the decision model reads: measured facts in plain words, no conclusions. */
export function describe(o: Observation) {
  const t = o.terms;
  const q = o.quote;
  const last = o.checks[0];
  const prev = o.checks[1];
  const state: Record<string, unknown> = {
    agreement: `Liquidity SLA on ${o.pair}. The market maker must keep at least ${amt(t.minDepth, q)} of committed bids within ${t.windowPct}% below the reference price and the same amount of asks within ${t.windowPct}% above it, with a spread no wider than ${t.maxSpreadBps} basis points. Committed liquidity is valued bin by bin, so trades against the book do not change it; only the maker's own placements and movements of the reference price do. It is checked at random times; ${t.maxFailures} failed periods in a row breach the agreement.`,
    scoring:
      o.scoringAgoSecs < 0
        ? `Scoring starts in ${within(-o.scoringAgoSecs)}: the agreement is in its setup window, when checks do not count yet.`
        : `Scoring started ${ago(o.scoringAgoSecs)}; every check counts.`,
  };
  // Where the maker's liquidity sits relative to the reference comes first: it explains the checks.
  if (!o.position.open) state.position = "The maker has no liquidity position open on the pair.";
  else if (o.position.lowerPct !== undefined && o.position.upperPct !== undefined) {
    const lo = o.position.lowerPct;
    const hi = o.position.upperPct;
    if (hi < 0) state.position = `The maker's position is open, but the reference price has risen above its whole range (the range ends ${Math.abs(hi).toFixed(1)}% below the reference), so its liquidity sits away from where the checks measure.`;
    else if (lo > 0) state.position = `The maker's position is open, but the reference price has fallen below its whole range (the range starts ${lo.toFixed(1)}% above the reference), so its liquidity sits away from where the checks measure.`;
    else state.position = `The maker's position is open and covers the reference price${Math.min(-lo, hi) < 1 ? ", which is close to the edge of its range" : " with room on both sides"}.`;
  }
  if (!last) state.latest_check = "No check has been recorded yet.";
  else {
    state.latest_check = [
      `${ago(last.agoSecs)}: ${last.ok ? "passed" : "failed"}.`,
      `Bids: ${sideWords(last.bids, t.minDepth, q)}.`,
      `Asks: ${sideWords(last.asks, t.minDepth, q)}.`,
      last.spreadBps === null ? "Spread: not measurable, one side has too little committed liquidity near the reference." : `Spread: ${last.spreadBps} basis points, ${last.spreadBps <= t.maxSpreadBps ? "within" : "wider than"} the limit.`,
    ].join(" ");
    if (prev) state.since_previous_check = `Compared with the check ${ago(prev.agoSecs)}, committed bids ${change(prev.bids, last.bids)} (${amt(prev.bids, q)} to ${amt(last.bids, q)}) and committed asks ${change(prev.asks, last.asks)} (${amt(prev.asks, q)} to ${amt(last.asks, q)}).`;
    const move = referenceMovePct(o);
    if (move !== null)
      state.reference_price = Math.abs(move) < 0.05 ? "The reference price did not move between the two latest checks." : `The reference price ${move > 0 ? "rose" : "fell"} ${Math.abs(move).toFixed(2)}% between the two latest checks.`;
    const earlier = o.checks.slice(1, 6);
    if (earlier.length) {
      const failed = earlier.filter((c) => !c.ok).length;
      state.earlier_checks = failed === 0 ? `All ${earlier.length} earlier checks passed.` : failed === earlier.length ? `All ${earlier.length} earlier checks failed.` : `${failed} of the ${earlier.length} earlier checks failed.`;
    }
  }
  state.failure_streak = o.failedPeriodsInARow === 0 ? "No failed periods in a row." : `${o.failedPeriodsInARow} failed period${o.failedPeriodsInARow === 1 ? "" : "s"} in a row so far; ${o.terms.maxFailures} breach the agreement.`;
  const lastCheckAgo = last?.agoSecs;
  const events = o.makerActivity.slice(0, 4).map((a) => `${ago(a.agoSecs)}${lastCheckAgo !== undefined ? (a.agoSecs < lastCheckAgo ? " (after the latest check)" : " (before the latest check)") : ""}: ${a.action}`);
  state.maker_activity = o.activityComplete
    ? events.length
      ? events
      : ["The maker has not placed or removed any liquidity yet."]
    : [...events, "The record of the maker's actions is incomplete: some recent transactions could not be read, so other actions may be missing."];
  if (o.escrowIdleShare !== null) {
    const s = o.escrowIdleShare;
    state.escrow = s > 0.9 ? "Almost all of the inventory is sitting idle in escrow, not quoted." : s > 0.4 ? "A large part of the inventory is sitting idle in escrow." : "Most of the inventory is deployed on the pair.";
  }
  if (o.record && o.record.periodsScored > 0) {
    const pct = Math.round((100 * o.record.periodsMet) / o.record.periodsScored);
    state.maker_record = `Service history: met ${pct}% of ${o.record.periodsScored} scored periods across ${o.record.agreements} agreement${o.record.agreements === 1 ? "" : "s"}; ${o.record.breaches} breached. This history comes from the program's counters and can include easy or self-dealt agreements.`;
  }
  return state;
}

export const QUESTIONS = {
  breach: {
    type: "noul" as const,
    instructions: "Will this agreement reach its limit of failed periods in a row before its term ends?",
    criteria: {
      true: "The maker has stopped maintaining the book, or its behaviour suggests it will not restore the obligations in time.",
      false: "The maker is maintaining the book, or any shortfall is likely to be fixed within a period or two.",
    },
  },
  diagnosis: {
    type: "choice" as const,
    instructions: "Which best describes the market maker's situation right now?",
    criteria: DIAGNOSES as Record<string, string | null>,
  },
  noRedeploy: {
    type: "noul" as const,
    instructions: "Over the next two scoring periods, will the maker fail to place liquidity that restores its obligations?",
    criteria: {
      true: "It has pulled out or stopped maintaining the book and shows no sign of placing liquidity again.",
      false: "It is likely to place or re-centre liquidity soon, as its recent actions or record suggest.",
    },
  },
};

type Q = typeof QUESTIONS;

export async function assessWithModel(cfg: SystemOneConfig, o: Observation): Promise<Assessment> {
  const rules = assessWithRules(o);
  const r = await decide<Q>(cfg, describe(o), QUESTIONS);
  const diagnosis = r.answers.diagnosis.choice as Diagnosis;
  const failing = FAILING.includes(diagnosis) || FAILING.includes(rules.diagnosis);
  return {
    // Rules own the scheduling risk; the model isn't asked for it.
    risk: rules.risk,
    breach: r.answers.breach.noul,
    diagnosis,
    confidence: r.answers.diagnosis.confidence,
    // Only meaningful while the obligations are unmet, and only with a complete history.
    noRedeploy: failing && o.activityComplete ? r.answers.noRedeploy.noul : NaN,
    source: r.model,
    latencyMs: r.latencyMs,
  };
}

// ---------------------------------------------------------------- rules

/** The deterministic baseline, and the source of the scheduling risk. */
export function assessWithRules(o: Observation): Assessment {
  const t = o.terms;
  const last = o.checks[0];
  const recentWithdraw = o.makerActivity.find((a) => /withdrew|pulled/.test(a.action) && a.agoSecs < 3 * t.periodSecs);
  const recentDeploy = o.makerActivity.find((a) => /placed|deployed/.test(a.action) && a.agoSecs < 2 * t.periodSecs);
  const known = (x: number) => (o.activityComplete ? x : NaN);
  const out = (risk: number, breach: number, diagnosis: Diagnosis, confidence: number, noRedeploy: number): Assessment => ({
    risk,
    breach,
    diagnosis,
    confidence: o.activityComplete ? confidence : Math.min(confidence, 0.6),
    noRedeploy,
    source: "rules",
    latencyMs: 0,
  });
  const inSetup = o.scoringAgoSecs < 0;
  // "Not started" only if the maker has never placed or withdrawn anything we know of; an
  // empty book after earlier activity is a withdrawal, however long ago it happened.
  const everActive = o.makerActivity.some((a) => /placed|deployed|withdrew|pulled/.test(a.action));
  if (!o.position.open && !everActive) {
    // Before scoring starts an empty book is expected; after, every check fails.
    return inSetup ? out(0.2, 0.1, "not_started", 0.8, NaN) : out(0.9, 0.5, "not_started", 0.8, known(0.5));
  }
  if (!o.position.open || (recentWithdraw && (!recentDeploy || recentDeploy.agoSecs > recentWithdraw.agoSecs))) return out(0.9, 0.8, "withdrew_liquidity", 0.85, known(0.8));
  if (o.position.lowerPct !== undefined && o.position.upperPct !== undefined && (o.position.lowerPct > 0 || o.position.upperPct < 0)) return out(0.85, 0.7, "out_of_range", 0.8, known(0.4));
  if (!last) return out(0.25, 0.2, "unclear", 0.4, NaN);
  const min = Math.min(last.bids, last.asks);
  const move = referenceMovePct(o);
  if (!last.ok && move !== null && Math.abs(move) >= 0.05) return out(0.7, 0.35, "reference_moved", 0.7, known(0.3));
  if (!last.ok) return out(0.7, 0.5, "unclear", 0.4, NaN);
  if (min < 1.3 * t.minDepth) return out(0.25, 0.1, "thin_but_compliant", 0.7, NaN);
  return out(0.05, 0.02, "quoting_normally", 0.9, NaN);
}

// ---------------------------------------------------------------- hybrid

/** Rules below this confidence defer their diagnosis to the model. */
export const RULES_CONFIDENT = 0.75;

/** Combine: rules keep the risk and confident diagnoses; the model supplies the outlooks. */
export function combine(rules: Assessment, model: Assessment | null): Assessment {
  if (!model) return rules;
  const useRules = rules.confidence >= RULES_CONFIDENT;
  return {
    risk: rules.risk,
    breach: model.breach,
    noRedeploy: model.noRedeploy,
    diagnosis: useRules ? rules.diagnosis : model.diagnosis,
    confidence: useRules ? rules.confidence : model.confidence,
    source: `${model.source}+rules`,
    latencyMs: model.latencyMs,
  };
}

/**
 * Rules first, the model for what they can't settle: clear-cut observations are decided in
 * code; ambiguous ones go to the decision model. If the model is unavailable the rules stand.
 */
export async function assessHybrid(cfg: SystemOneConfig | null, o: Observation, gate = RULES_CONFIDENT): Promise<Assessment> {
  const r = assessWithRules(o);
  if (!cfg || r.confidence >= gate) return r;
  try {
    return combine(r, await assessWithModel(cfg, o));
  } catch {
    return r;
  }
}
