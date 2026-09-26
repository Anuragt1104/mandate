/**
 * The renewal report's reasoning: incidents and recovery times from an agreement's score log,
 * gaps in observation, and proposed changes for the next term with the evidence behind each.
 * Proposals are suggestions for two parties to discuss, each tied to what was observed; the
 * report never changes a live agreement (terms are immutable), it only seeds a new draft.
 */
import type { DraftTerms } from "./draft";

export interface LogPeriod {
  period: number;
  /** 1 met, 2 failed, 3 unobserved */
  status: number;
  snapshots: number;
  /** Committed depth, quote UI units. */
  minBid: number;
  minAsk: number;
  worstSpreadBps: number;
}

export interface Incident {
  from: number;
  to: number;
  periods: number;
  durationSecs: number;
  /** Seconds from the first failed period's start to the start of the next met period; null if it never recovered in the log. */
  recoveredAfterSecs: number | null;
  causes: ("bids" | "asks" | "spread" | "empty side")[];
}

const EMPTY = 65535;

export function incidentsOf(log: LogPeriod[], periodSecs: number, minDepth: number, maxSpreadBps: number): Incident[] {
  const out: Incident[] = [];
  let cur: Incident | null = null;
  for (const e of log) {
    if (e.status === 2) {
      cur ??= { from: e.period, to: e.period, periods: 0, durationSecs: 0, recoveredAfterSecs: null, causes: [] };
      cur.to = e.period;
      cur.periods++;
      cur.durationSecs = (cur.to - cur.from + 1) * periodSecs;
      const add = (c: Incident["causes"][number]) => !cur!.causes.includes(c) && cur!.causes.push(c);
      if (e.minBid < minDepth) add("bids");
      if (e.minAsk < minDepth) add("asks");
      if (e.worstSpreadBps === EMPTY) add("empty side");
      else if (e.worstSpreadBps > maxSpreadBps) add("spread");
    } else if (e.status === 1 && cur) {
      cur.recoveredAfterSecs = (e.period - cur.from) * periodSecs;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function gapsOf(log: LogPeriod[]): { from: number; to: number; periods: number }[] {
  const out: { from: number; to: number; periods: number }[] = [];
  for (const e of log) {
    if (e.status !== 3) continue;
    const last = out[out.length - 1];
    if (last && last.to === e.period - 1) (last.to = e.period), last.periods++;
    else out.push({ from: e.period, to: e.period, periods: 1 });
  }
  return out;
}

export interface Proposal {
  id: string;
  title: string;
  /** The evidence, in words. */
  why: string;
  /** Term changes this proposal makes (absent for process changes such as funding a watchtower). */
  change?: Partial<DraftTerms>;
}

const q = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));
const niceDown = (x: number) => {
  if (x <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
};
const quantile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
};

export function proposeChanges(o: {
  terms: DraftTerms;
  log: LogPeriod[];
  counters: { ok: number; failed: number; unobserved: number };
  breached: boolean;
  quote: string;
}): Proposal[] {
  const t = o.terms;
  const minDepth = Number(t.minDepth);
  const maxSpread = Number(t.maxSpreadBps);
  const out: Proposal[] = [];
  const total = o.counters.ok + o.counters.failed + o.counters.unobserved;
  const failed = o.log.filter((e) => e.status === 2);
  const met = o.log.filter((e) => e.status === 1);
  const sideFails = { bids: failed.filter((e) => e.minBid < minDepth).length, asks: failed.filter((e) => e.minAsk < minDepth).length, spread: failed.filter((e) => e.worstSpreadBps !== EMPTY && e.worstSpreadBps > maxSpread).length };

  if (total > 0 && o.counters.unobserved / total > 0.1) {
    out.push({ id: "monitoring", title: "Agree who funds checking", why: `${o.counters.unobserved} of ${total} periods (${Math.round((100 * o.counters.unobserved) / total)}%) had no check, so they were neither paid nor failed. Name who runs a watchtower and who pays its fees.` });
  }
  if (sideFails.asks > 0 && sideFails.asks >= sideFails.bids) {
    const base = Number(t.baseDeposit);
    out.push({
      id: "asks-inventory",
      title: "More token inventory for the ask side",
      why: `Committed asks fell below ${q(minDepth)} ${o.quote} in ${sideFails.asks} failed period${sideFails.asks === 1 ? "" : "s"}. Once traders buy through the asks, the operator can't replace them without token inventory.`,
      change: base > 0 ? { baseDeposit: String(Math.round(base * 2)) } : undefined,
    });
  }
  if (sideFails.bids > 0 && sideFails.bids > sideFails.asks) {
    out.push({
      id: "bids-inventory",
      title: "More quote inventory for the bid side",
      why: `Committed bids fell below ${q(minDepth)} ${o.quote} in ${sideFails.bids} failed period${sideFails.bids === 1 ? "" : "s"}.`,
      change: { quoteDeposit: String(Math.round(Number(t.quoteDeposit) * 1.5)) },
    });
  }
  if (sideFails.spread > 0) {
    out.push({ id: "spread", title: "Loosen the spread limit a little", why: `The spread was wider than ${maxSpread} bps in ${sideFails.spread} failed period${sideFails.spread === 1 ? "" : "s"}.`, change: { maxSpreadBps: String(Math.round(maxSpread * 1.5)) } });
  }
  if (o.breached) {
    out.push({
      id: "failures",
      title: "Give recovery more room, or change operator",
      why: `The agreement breached after ${t.maxConsecutiveFailures} failed periods in a row. Either allow more time to recover, with a larger bond at stake, or put another operator under the same terms.`,
      change: { maxConsecutiveFailures: String(Number(t.maxConsecutiveFailures) + 2), bond: String(Math.round(Number(t.bond) * 1.5)) },
    });
  }
  const bids = met.map((e) => e.minBid);
  const asks = met.map((e) => e.minAsk);
  const floor = Math.min(quantile(bids, 0.1) ?? 0, quantile(asks, 0.1) ?? 0);
  if (!failed.length && met.length >= 12 && floor >= 2 * minDepth) {
    const next = niceDown(floor);
    out.push({ id: "tighten", title: "Ask for the depth that was actually delivered", why: `Every checked period met the terms, and the operator kept at least ${q(floor)} ${o.quote} each side in 9 of 10 periods, ${(floor / minDepth).toFixed(1)}× the minimum.`, change: { minDepth: String(next) } });
  }
  if (!failed.length && !o.breached && o.counters.ok > 0 && out.length === 0) {
    out.push({ id: "same", title: "Renew on the same terms", why: `${o.counters.ok} periods met, none failed.` });
  }
  return out;
}

/** Apply the chosen proposals' term changes. */
export function applyProposals(terms: DraftTerms, proposals: Proposal[]): DraftTerms {
  return proposals.reduce((t, p) => ({ ...t, ...(p.change ?? {}) }), terms);
}
