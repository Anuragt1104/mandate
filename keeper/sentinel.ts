/**
 * The sentinel: a System One triage for watchtowers. Code gathers what a watchtower can
 * observe about an SLA and states every comparison in words (decision models are weak at
 * arithmetic); one call to a decision model (Jev by default) returns
 *   - risk:       probability that the next check will find the obligations unmet
 *   - diagnosis:  what the maker's situation looks like, for the status page
 *   - exit:       probability the maker is leaving on purpose
 *   - breach:     probability the maker lets the agreement breach (misses periods in a row)
 * Watchtowers use the risk to decide where to spend their checks; the status page shows the
 * diagnosis and the breach outlook. Nothing here touches enforcement: the program still
 * measures, pays and slashes on its own.
 */
import { decide, type SystemOneConfig } from "../sdk/src/systemone";
import { encodeSentinelMemo, type Diagnosis, type SentinelAssessment } from "../sdk/src/sentinel";

export type { Diagnosis };

/** How each diagnosis is described to the decision model. */
export const DIAGNOSES: Record<Diagnosis, string | null> = {
  quoting_normally: "Both sides hold enough liquidity near the reference and the spread is tight; nothing is wrong.",
  thin_but_compliant: "The obligations are met, but one side is only a little above its minimum.",
  withdrew_liquidity: "The market maker pulled its liquidity back into escrow, so little or nothing is being quoted.",
  side_depleted_by_trading: "Traders bought or sold through one side of the book, so that side dropped below its minimum while the other side grew.",
  out_of_range: "The price moved past the range the maker's position covers, so its liquidity no longer counts.",
  not_started: "The maker accepted the agreement recently and has not placed any liquidity yet.",
  unclear: null,
};

export interface Measurement {
  agoSecs: number;
  ok: boolean;
  bids: number;
  asks: number;
  spreadBps: number | null; // null when a side is empty
}

export interface Observation {
  pair: string;
  quote: string;
  terms: { minDepth: number; windowPct: number; maxSpreadBps: number; periodSecs: number; maxFailures: number };
  acceptedAgoSecs: number;
  checks: Measurement[]; // newest first
  failedPeriodsInARow: number;
  makerActivity: { agoSecs: number; action: string }[]; // newest first
  position: { open: boolean; lowerPct?: number; upperPct?: number };
  escrowIdleShare: number | null; // share of the inventory sitting idle in escrow
  record: { periodsMet: number; periodsScored: number; breaches: number; agreements: number } | null;
}

export interface Assessment extends SentinelAssessment {
  latencyMs: number;
}

// ---------------------------------------------------------------- state

const ago = (s: number) => (s < 90 ? `${Math.round(s)} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago`);
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

/** What the decision model reads: evidence in plain words, no conclusions. */
export function describe(o: Observation) {
  const t = o.terms;
  const q = o.quote;
  const last = o.checks[0];
  const prev = o.checks[1];
  const setup = o.acceptedAgoSecs < t.periodSecs;
  const state: Record<string, unknown> = {
    agreement: `Liquidity SLA on ${o.pair}. The market maker must keep at least ${amt(t.minDepth, q)} of bids within ${t.windowPct}% below the reference price and the same amount of asks within ${t.windowPct}% above it, with a spread no wider than ${t.maxSpreadBps} basis points. It is checked at random times; ${t.maxFailures} failed periods in a row breach the agreement.`,
    maker_accepted: setup
      ? `${ago(o.acceptedAgoSecs)}, so the agreement is still in its one-minute setup window, when checks do not count yet.`
      : `${ago(o.acceptedAgoSecs)}; the setup window is over and every check counts.`,
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
      last.spreadBps === null ? "Spread: not measurable, one side of the book is empty." : `Spread: ${last.spreadBps} basis points, ${last.spreadBps <= t.maxSpreadBps ? "within" : "wider than"} the limit.`,
    ].join(" ");
    if (prev) state.since_previous_check = `Compared with the check ${ago(prev.agoSecs)}, bids ${change(prev.bids, last.bids)} (${amt(prev.bids, q)} to ${amt(last.bids, q)}) and asks ${change(prev.asks, last.asks)} (${amt(prev.asks, q)} to ${amt(last.asks, q)}).`;
    const earlier = o.checks.slice(1, 6);
    if (earlier.length) {
      const failed = earlier.filter((c) => !c.ok).length;
      state.earlier_checks = failed === 0 ? `All ${earlier.length} earlier checks passed.` : failed === earlier.length ? `All ${earlier.length} earlier checks failed.` : `${failed} of the ${earlier.length} earlier checks failed.`;
    }
  }
  state.failure_streak = o.failedPeriodsInARow === 0 ? "No failed periods in a row." : `${o.failedPeriodsInARow} failed period${o.failedPeriodsInARow === 1 ? "" : "s"} in a row so far; ${o.terms.maxFailures} breach the agreement.`;
  const lastCheckAgo = last?.agoSecs;
  state.maker_activity = o.makerActivity.length
    ? o.makerActivity.slice(0, 4).map((a) => `${ago(a.agoSecs)}${lastCheckAgo !== undefined ? (a.agoSecs < lastCheckAgo ? " (after the latest check)" : " (before the latest check)") : ""}: ${a.action}`)
    : ["The maker has not placed or removed any liquidity yet."];
  if (o.escrowIdleShare !== null) {
    const s = o.escrowIdleShare;
    state.escrow = s > 0.9 ? "Almost all of the inventory is sitting idle in escrow, not quoted." : s > 0.4 ? "A large part of the inventory is sitting idle in escrow." : "Most of the inventory is deployed on the pair.";
  }
  if (o.record && o.record.periodsScored > 0) {
    const pct = Math.round((100 * o.record.periodsMet) / o.record.periodsScored);
    state.maker_record = `Met ${pct}% of ${o.record.periodsScored} scored periods across its agreements; breached ${o.record.breaches} of ${o.record.agreements}.`;
  }
  return state;
}

export const QUESTIONS = {
  risk: {
    type: "noul" as const,
    instructions: "Will the next check of this agreement most likely find the market maker's obligations unmet?",
    criteria: {
      true: "Liquidity is missing, has left, is out of range, or a side is below its minimum and has not been refilled yet.",
      false: "Both sides are above their minimums, or the maker has just restored the book.",
    },
  },
  breach: {
    type: "noul" as const,
    instructions: "Is this market maker likely to let the agreement breach by missing several periods in a row?",
    criteria: {
      true: "The maker has stopped maintaining the book, or its record and recent behaviour suggest it will not fix the problem in time.",
      false: "The maker is maintaining the book, or its record suggests any shortfall will be fixed within a period or two.",
    },
  },
  diagnosis: {
    type: "choice" as const,
    instructions: "Which best describes the market maker's situation right now?",
    criteria: DIAGNOSES as Record<string, string | null>,
  },
  exit: {
    type: "noul" as const,
    instructions: "Does the maker's recent activity suggest it is deliberately leaving this market?",
    criteria: {
      true: "It pulled liquidity and shows no sign of coming back.",
      false: "It is maintaining its quotes, or a gap came from trading or price moves.",
    },
  },
};

export async function assessWithModel(cfg: SystemOneConfig, o: Observation): Promise<Assessment> {
  const r = await decide(cfg, describe(o), QUESTIONS);
  return {
    risk: r.answers.risk.noul,
    breach: r.answers.breach.noul,
    diagnosis: (r.answers.diagnosis.choice as Diagnosis) ?? "unclear",
    confidence: r.answers.diagnosis.confidence,
    exit: r.answers.exit.noul,
    source: r.model,
    latencyMs: r.latencyMs,
  };
}

// ---------------------------------------------------------------- rules

/** The deterministic baseline: the same outputs from hand-written rules. */
export function assessWithRules(o: Observation): Assessment {
  const t = o.terms;
  const last = o.checks[0];
  const prev = o.checks[1];
  const recentWithdraw = o.makerActivity.find((a) => /withdrew|pulled/.test(a.action) && a.agoSecs < 3 * t.periodSecs);
  const recentDeploy = o.makerActivity.find((a) => /placed|deployed/.test(a.action) && a.agoSecs < 2 * t.periodSecs);
  const out = (risk: number, breach: number, diagnosis: Diagnosis, confidence: number, exit: number): Assessment => ({ risk, breach, diagnosis, confidence, exit, source: "rules", latencyMs: 0 });
  if (!o.position.open && !recentWithdraw && o.acceptedAgoSecs < 2 * t.periodSecs) return out(0.2, 0.1, "not_started", 0.8, 0.1);
  if (!o.position.open || (recentWithdraw && (!recentDeploy || recentDeploy.agoSecs > recentWithdraw.agoSecs))) return out(0.9, 0.8, "withdrew_liquidity", 0.85, 0.8);
  if (o.position.lowerPct !== undefined && o.position.upperPct !== undefined && (o.position.lowerPct > 0 || o.position.upperPct < 0)) return out(0.85, 0.7, "out_of_range", 0.8, 0.3);
  if (!last) return out(o.position.open ? 0.25 : 0.5, 0.2, "unclear", 0.4, 0.1);
  const min = Math.min(last.bids, last.asks);
  if (!last.ok && prev && ((last.asks < t.minDepth && last.bids > prev.bids) || (last.bids < t.minDepth && last.asks > prev.asks))) return out(0.7, 0.35, "side_depleted_by_trading", 0.7, 0.1);
  if (!last.ok) return out(0.7, 0.5, "unclear", 0.4, 0.3);
  if (min < 1.3 * t.minDepth) return out(0.25, 0.1, "thin_but_compliant", 0.7, 0.05);
  return out(0.05, 0.02, "quoting_normally", 0.9, 0.02);
}

// ---------------------------------------------------------------- hybrid

/**
 * Rules first, the model for what they can't settle: clear-cut observations are decided in
 * code; ambiguous ones (the rules' own confidence below `gate`) go to the decision model.
 * If the model is unavailable the rules' answer stands.
 */
export async function assessHybrid(cfg: SystemOneConfig | null, o: Observation, gate = 0.75): Promise<Assessment> {
  const r = assessWithRules(o);
  if (!cfg || r.confidence >= gate) return r;
  try {
    const m = await assessWithModel(cfg, o);
    return { ...m, source: `${m.source}+rules` };
  } catch {
    return r;
  }
}

// ---------------------------------------------------------------- memo

export const encodeMemo = encodeSentinelMemo;
