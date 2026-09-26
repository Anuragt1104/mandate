/**
 * How an on-chain mandate reads as a service-level agreement: its current status, the
 * per-obligation uptime history, incidents, the maker's rating and whether the committed
 * book keeps the token routable. Everything here is derived from account data.
 */
import { PublicKey } from "@solana/web3.js";
import type { BookBin } from "./chain";

export type Tone = "up" | "warn" | "down" | "open" | "ended";
export type StatusName = "Open" | "Active" | "Breached" | "Expired" | "Settled" | "Cancelled";

export interface PeriodEntry {
  period: number;
  status: number; // 1 ok, 2 failed, 3 unobserved
  snapshots: number;
  worstSpreadBps: number;
  minBidDepth: any;
  minAskDepth: any;
}

const n = (v: any) => Number(v?.toString?.() ?? v);
const EMPTY_SIDE = 65535;

/** Quote amounts in UI units, in the quote mint's own decimals (never assumed). */
export function quoteUnits(decimals: number) {
  return (v: any) => n(v) / 10 ** decimals;
}

// ---------------------------------------------------------------- status

export interface SlaStatus {
  tone: Tone;
  word: string;
  headline: string;
  detail: string;
}

/** Which obligations the latest check missed, in words. */
export function missed(m: any): string[] {
  const t = m.terms;
  const l = m.last;
  const out: string[] = [];
  if (n(l.bidDepthQuote) < n(t.minDepthQuote)) out.push("bids below the minimum");
  if (n(l.askDepthQuote) < n(t.minDepthQuote)) out.push("asks below the minimum");
  if (l.spreadBps === EMPTY_SIDE) out.push("a side of the book is empty");
  else if (l.spreadBps > t.maxSpreadBps) out.push("spread too wide");
  return out;
}

export function slaStatus(m: any, status: StatusName, now: number, names: { maker: string; quote: string; decimals: number | undefined }, ago: (s: number) => string): SlaStatus {
  const t = m.terms;
  const q = names.decimals === undefined ? () => NaN : quoteUnits(names.decimals);
  const money = (v: any) => (names.decimals === undefined ? "an unknown amount of" : q(v).toLocaleString("en-US"));
  const bond = money(t.bondAmount);
  switch (status) {
    case "Open": {
      const designated = !(m.maker as PublicKey).equals(PublicKey.default);
      return {
        tone: "open",
        word: "Open",
        headline: "Awaiting a market maker",
        detail: `Funded and open to ${designated ? "its designated maker" : "any maker"}. Scoring starts when a maker accepts and posts a ${bond} ${names.quote} bond.`,
      };
    }
    case "Active": {
      if (now < n(m.startTs)) {
        return { tone: "open", word: "Starting", headline: "Setting up", detail: `${names.maker} has accepted and is placing its quotes. Scoring starts at the end of the one-minute setup window.` };
      }
      if (!m.snapshotsTotal) {
        return { tone: "warn", word: "Unmonitored", headline: "Not checked yet", detail: "Scoring has started but nobody has checked yet. Periods nobody checks are neither paid nor failed; anyone can run a check." };
      }
      const since = now - n(m.last.ts);
      if (since > 3 * t.periodSecs + 60) {
        return { tone: "warn", word: "Unmonitored", headline: "Not checked recently", detail: `The last check was ${ago(since)}. Periods nobody checks are neither paid nor failed; anyone can run a check.` };
      }
      if (m.last.ok) {
        return { tone: "up", word: "Operational", headline: "Operational", detail: `All obligations met at the last check, ${ago(since)}.` };
      }
      const streak = m.consecutiveFailed as number;
      const miss = missed(m);
      return {
        tone: "warn",
        word: "Degraded",
        headline: "Degraded",
        detail: `Last check, ${ago(since)}: ${miss.join(", ") || "an obligation was missed"}. ${streak ? `${streak} failed period${streak === 1 ? "" : "s"} with no pass since; ` : ""}the bond is slashed after ${t.maxConsecutiveFailures}.`,
      };
    }
    case "Breached":
      return {
        tone: "down",
        word: "Breached",
        headline: "Breached",
        detail: `${names.maker} failed ${t.maxConsecutiveFailures} checked periods with no passing period between them. ${money(m.bondSlashed)} ${names.quote} of its bond was slashed and the agreement ended.`,
      };
    case "Expired":
      return { tone: "ended", word: "Term complete", headline: "Term complete", detail: "The agreement ran its full term. Anyone can unwind the position and settle." };
    case "Settled":
      return n(m.bondSlashed) > 0
        ? { tone: "down", word: "Breached", headline: "Breached and settled", detail: `${names.maker} was slashed ${money(m.bondSlashed)} ${names.quote}. The inventory went back to the issuer.` }
        : { tone: "ended", word: "Settled", headline: "Completed and settled", detail: "The term ended and every balance was paid out." };
    case "Cancelled":
      return { tone: "ended", word: "Cancelled", headline: "Cancelled", detail: "The issuer withdrew the offer before any maker accepted." };
  }
}

// ---------------------------------------------------------------- obligations

export type TickKind = "up" | "down" | "idle" | "future" | "live" | "live-bad";
export interface Tick {
  kind: TickKind;
  label: string;
  lines: string[];
}

export interface Obligation {
  key: "bids" | "asks" | "spread";
  name: string;
  target: string;
  ticks: Tick[];
  met: number;
  observed: number;
  now: { text: string; pass: boolean | null };
}

/** Per-obligation uptime from the score log, with the current period as a live tick. */
export function obligations(m: any, status: StatusName, entries: PeriodEntry[], cells: number, quote: string, fmt: (x: number) => string, decimals: number): { rows: Obligation[]; overall: Tick[] } {
  const t = m.terms;
  const q = quoteUnits(decimals);
  const min = n(t.minDepthQuote);
  const window = `${t.depthWindowBps / 100}%`;
  const shown = entries.slice(-(cells - 1));
  const live = status === "Active" && m.curSnapshots > 0;
  const checked = m.snapshotsTotal > 0;
  const periodLabel = (p: number) => `Period ${p + 1}`;

  const make = (key: Obligation["key"], name: string, target: string, ok: (e: PeriodEntry) => boolean, describe: (e: PeriodEntry) => string, liveOk: () => boolean, nowText: () => string, nowPass: () => boolean): Obligation => {
    const ticks: Tick[] = shown.map((e) =>
      e.status === 3
        ? { kind: "idle", label: `${periodLabel(e.period)} · not checked`, lines: ["Nobody checked this period, so it is neither paid nor failed."] }
        : { kind: ok(e) ? "up" : "down", label: `${periodLabel(e.period)} · ${ok(e) ? "met" : "missed"}`, lines: [describe(e), `${e.snapshots} check${e.snapshots === 1 ? "" : "s"}`] },
    );
    if (live) ticks.push({ kind: liveOk() ? "live" : "live-bad", label: `${periodLabel(m.currentPeriod)} · in progress`, lines: [`${m.curSnapshots} check${m.curSnapshots === 1 ? "" : "s"} so far`] });
    while (ticks.length < cells) ticks.unshift({ kind: "future", label: "", lines: [] });
    const observed = shown.filter((e) => e.status !== 3);
    return {
      key, name, target, ticks,
      met: observed.filter(ok).length,
      observed: observed.length,
      now: checked && status === "Active" ? { text: nowText(), pass: nowPass() } : { text: "—", pass: null },
    };
  };

  const rows = [
    make("bids", "Bid depth", `≥ ${fmt(q(min))} ${quote} in the bins within ${window} below`,
      (e) => n(e.minBidDepth) >= min, (e) => `Lowest bids ${fmt(q(e.minBidDepth))} ${quote}`,
      () => n(m.curMinBidDepth) >= min, () => `${fmt(q(m.last.bidDepthQuote))} ${quote}`, () => n(m.last.bidDepthQuote) >= min),
    make("asks", "Ask depth", `≥ ${fmt(q(min))} ${quote} in the bins within ${window} above`,
      (e) => n(e.minAskDepth) >= min, (e) => `Lowest asks ${fmt(q(e.minAskDepth))} ${quote}`,
      () => n(m.curMinAskDepth) >= min, () => `${fmt(q(m.last.askDepthQuote))} ${quote}`, () => n(m.last.askDepthQuote) >= min),
    make("spread", "Spread", `≤ ${t.maxSpreadBps} bps at size`,
      (e) => e.worstSpreadBps <= t.maxSpreadBps, (e) => (e.worstSpreadBps === EMPTY_SIDE ? "A side of the book was empty" : `Widest spread ${e.worstSpreadBps} bps`),
      () => m.curWorstSpreadBps <= t.maxSpreadBps, () => (m.last.spreadBps === EMPTY_SIDE ? "one side empty" : `${m.last.spreadBps} bps`), () => m.last.spreadBps <= t.maxSpreadBps),
  ];
  const overall: Tick[] = shown.map((e) => ({
    kind: e.status === 1 ? "up" : e.status === 2 ? "down" : "idle",
    label: `${periodLabel(e.period)} · ${e.status === 1 ? "compliant" : e.status === 2 ? "failed" : "not checked"}`,
    lines: e.status === 3 ? ["Neither paid nor failed."] : [`${e.snapshots} check${e.snapshots === 1 ? "" : "s"}`],
  }));
  if (live) overall.push({ kind: m.curFailedSnapshots > 0 ? "live-bad" : "live", label: `${periodLabel(m.currentPeriod)} · in progress`, lines: [`${m.curSnapshots} check${m.curSnapshots === 1 ? "" : "s"} so far`] });
  return { rows, overall };
}

/** The last `cells` periods as board ticks, padded with future cells for young agreements. */
export function boardTicks(m: any, status: StatusName, entries: PeriodEntry[], cells: number): Tick[] {
  const shown = entries.slice(-(cells - 1));
  const ticks: Tick[] = shown.map((e) => ({
    kind: e.status === 1 ? "up" : e.status === 2 ? "down" : "idle",
    label: `Period ${e.period + 1} · ${e.status === 1 ? "compliant" : e.status === 2 ? "failed" : "not checked"}`,
    lines: [],
  }));
  if (status === "Active" && m.curSnapshots > 0) ticks.push({ kind: m.curFailedSnapshots > 0 ? "live-bad" : "live", label: `Period ${m.currentPeriod + 1} · in progress`, lines: [] });
  while (ticks.length < cells) ticks.unshift({ kind: "future", label: "", lines: [] });
  return ticks;
}

export function uptime(entries: PeriodEntry[]): number | null {
  const ok = entries.filter((e) => e.status === 1).length;
  const failed = entries.filter((e) => e.status === 2).length;
  return ok + failed ? ok / (ok + failed) : null;
}

export function pct(r: number | null, digits = 1) {
  if (r === null) return "—";
  return `${(r * 100).toFixed(r === 1 ? 0 : digits)}%`;
}

// ---------------------------------------------------------------- incidents

export interface Incident {
  from: number;
  to: number;
  count: number;
  what: string[];
  ongoing: boolean;
  breach: boolean;
  startTs: number;
}

/** Runs of failed periods, newest first. */
export function incidents(m: any, status: StatusName, entries: PeriodEntry[]): Incident[] {
  const t = m.terms;
  const min = n(t.minDepthQuote);
  const out: Incident[] = [];
  let cur: Incident | null = null;
  for (const e of entries) {
    if (e.status === 2) {
      const what = new Set<string>(cur?.what ?? []);
      if (n(e.minBidDepth) < min) what.add("bids");
      if (n(e.minAskDepth) < min) what.add("asks");
      if (e.worstSpreadBps > t.maxSpreadBps) what.add(e.worstSpreadBps === EMPTY_SIDE ? "empty side" : "spread");
      if (!cur) cur = { from: e.period, to: e.period, count: 0, what: [], ongoing: false, breach: false, startTs: n(m.startTs) + e.period * t.periodSecs };
      cur.to = e.period;
      cur.count += 1;
      cur.what = [...what];
    } else if (e.status === 1 && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.breach = cur.count >= t.maxConsecutiveFailures && n(m.bondSlashed) > 0;
    cur.ongoing = !cur.breach && status === "Active";
    out.push(cur);
  }
  return out.reverse();
}

// ---------------------------------------------------------------- ratings

export interface Rating {
  grade: string;
  cls: "g-a" | "g-b" | "g-d" | "g-nr";
  why: string;
}

/**
 * A credit-style grade from the maker's on-chain record. Defaulting on most of its
 * agreements rates D; any breach caps the grade at BB; under 10 scored periods is not rated.
 */
export function rating(p: { periodsOk: any; periodsFailed: any; mandatesAccepted: number; mandatesBreached: number }): Rating {
  const ok = n(p.periodsOk);
  const failed = n(p.periodsFailed);
  const scored = ok + failed;
  const breached = p.mandatesBreached;
  if (breached > 0 && breached * 2 >= p.mandatesAccepted) return { grade: "D", cls: "g-d", why: `Breached ${breached} of ${p.mandatesAccepted} agreements.` };
  if (scored < 10) return { grade: "NR", cls: "g-nr", why: `Not rated yet: ${scored} scored period${scored === 1 ? "" : "s"}, 10 needed.` };
  const r = ok / scored;
  const ladder: [number, string][] = [[0.995, "AAA"], [0.98, "AA"], [0.95, "A"], [0.9, "BBB"], [0.8, "BB"], [0, "B"]];
  let grade = ladder.find(([min]) => r >= min)![1];
  if (breached > 0 && ["AAA", "AA", "A", "BBB"].includes(grade)) grade = "BB";
  const cls = grade.startsWith("A") ? "g-a" : "g-b";
  return { grade, cls, why: `${(r * 100).toFixed(1)}% of ${scored.toLocaleString("en-US")} scored periods met${breached ? `; ${breached} breach${breached === 1 ? "" : "es"}` : ""}.` };
}

// ---------------------------------------------------------------- routability

/**
 * Cost of buying `size` quote worth of the token and selling it straight back through the
 * committed book only (other liquidity on the pair makes it cheaper), before swap fees.
 */
export function roundTrip(bins: BookBin[], activeBin: number, size: number): { loss: number; filled: boolean } | null {
  const asks = bins.filter((b) => b.base > 0 && b.binId >= activeBin).sort((a, b) => a.binId - b.binId);
  const bids = bins.filter((b) => b.quote > 0 && b.binId <= activeBin).sort((a, b) => b.binId - a.binId);
  if (!asks.length || !bids.length) return null;
  let spend = size;
  let got = 0;
  for (const b of asks) {
    const cost = b.base * b.priceUi;
    if (cost >= spend) {
      got += spend / b.priceUi;
      spend = 0;
      break;
    }
    got += b.base;
    spend -= cost;
  }
  let filled = spend === 0;
  let sell = got;
  let back = 0;
  for (const b of bids) {
    const capacity = b.quote / b.priceUi;
    if (capacity >= sell) {
      back += sell * b.priceUi;
      sell = 0;
      break;
    }
    back += b.quote;
    sell -= capacity;
  }
  filled = filled && sell === 0;
  const spent = size - spend;
  return { loss: spent > 0 ? 1 - back / spent : 1, filled };
}
