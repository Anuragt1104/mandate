"use client";

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import type { EvalTerms, ExecutionStat, Readiness } from "../../../sdk/src/report";
import { InfoTip, fmt } from "./ui";

/** One tick per period from a verdict code string (m met, x missed, u unknown, - unobserved). */
export function PeriodStrip({ codes, periodSecs, startedAt, cells = 60 }: { codes: string; periodSecs: number; startedAt: number; cells?: number }) {
  const shown = codes.slice(-cells);
  const offset = codes.length - shown.length;
  const kind = (c: string) => (c === "m" ? "up" : c === "x" ? "down" : c === "u" ? "warn" : "idle");
  const word = (c: string) => (c === "m" ? "met" : c === "x" ? "missed" : c === "u" ? "evidence incomplete" : "not observed");
  const pad = Math.max(0, Math.min(cells, 24) - shown.length);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div className="ticks lg" role="img" aria-label={`${shown.length} periods`}>
        {Array.from({ length: pad }).map((_, i) => <span key={`f${i}`} className="tick" />)}
        {[...shown].map((c, i) => {
          const at = new Date((startedAt + (offset + i) * periodSecs) * 1000);
          return <span key={i} className={`tick ${kind(c)}`} title={`${at.toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · ${word(c)}`} />;
        })}
      </div>
      <div className="row wrap xs muted" style={{ gap: 12 }}>
        <span className="row" style={{ gap: 5 }}><i className="swatch" style={{ background: "var(--up)" }} />met</span>
        <span className="row" style={{ gap: 5 }}><i className="swatch" style={{ background: "var(--down)" }} />missed</span>
        <span className="row" style={{ gap: 5 }}><i className="swatch" style={{ background: "var(--warn)" }} />evidence incomplete</span>
        <span className="row" style={{ gap: 5 }}><i className="swatch" style={{ background: "var(--idle)" }} />not observed</span>
      </div>
    </div>
  );
}

export function ReadinessPanel({ r }: { r: Readiness }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="row-between">
        <span className="row" style={{ gap: 8, fontWeight: 600 }}>
          {r.ready ? <CircleCheck style={{ width: 16, color: "var(--up)" }} /> : <CircleDashed style={{ width: 16, color: "var(--muted)" }} />}
          {r.ready ? "Enough evidence to interpret" : "Collecting evidence"}
        </span>
        <span className="xs muted num">{Math.round(r.progress * 100)}%</span>
      </div>
      <span className="meter" aria-hidden="true"><span style={{ width: `${Math.max(2, r.progress * 100)}%`, background: r.ready ? undefined : "var(--muted)" }} /></span>
      {r.needs.map((n) => <span key={n} className="small" style={{ color: "var(--ink-2)" }}>{n}</span>)}
      {r.missing.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <span className="xs muted" style={{ fontWeight: 600 }}>Missing or incomplete evidence</span>
          {r.missing.map((m) => (
            <span key={m} className="small row" style={{ gap: 6, alignItems: "flex-start", color: "var(--ink-2)" }}>
              <CircleAlert style={{ width: 14, flex: "none", marginTop: 3, color: "var(--warn)" }} />{m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReplaySummary({ s, failures, observed, terms, quote, unobserved }: {
  s: { met: number; missed: number; unknown: number; decided: number; longestMissRun: number };
  failures: { bids: number; asks: number; spread: number };
  observed: { bidP10: number | null; askP10: number | null; spreadMedian: number | null };
  terms: EvalTerms;
  quote: string;
  unobserved: number;
}) {
  const rate = s.decided ? s.met / s.decided : null;
  const cell = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div style={{ display: "grid", gap: 2 }}>
      <span className="xs muted">{label}</span>
      <span className="num" style={{ fontSize: 20, fontWeight: 650 }}>{value}</span>
      {sub && <span className="xs muted">{sub}</span>}
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 16 }}>
        {cell("Periods met", rate === null ? "—" : `${s.met} of ${s.decided}`, rate === null ? "none decided yet" : `${(rate * 100).toFixed(1)}%`)}
        {cell("Longest run missed", s.longestMissRun, `${s.missed} missed in all`)}
        {cell("Not decided", s.unknown + unobserved, `${s.unknown} incomplete · ${unobserved} unobserved`)}
      </div>
      <div className="table-wrap">
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th>Threshold</th><th className="r">Replayed</th><th className="r">Checks failing it</th><th className="r">Observed (lower tenth / median)</th></tr></thead>
          <tbody>
            <tr><td>Committed bids</td><td className="r num">≥ {fmt(terms.minDepth, 0)} {quote}</td><td className="r num" style={{ color: failures.bids ? "var(--down)" : undefined }}>{failures.bids}</td><td className="r num">{observed.bidP10 === null ? "—" : `${fmt(observed.bidP10, 0)} ${quote}`}</td></tr>
            <tr><td>Committed asks</td><td className="r num">≥ {fmt(terms.minDepth, 0)} {quote}</td><td className="r num" style={{ color: failures.asks ? "var(--down)" : undefined }}>{failures.asks}</td><td className="r num">{observed.askP10 === null ? "—" : `${fmt(observed.askP10, 0)} ${quote}`}</td></tr>
            <tr><td>Spread at size</td><td className="r num">≤ {terms.maxSpreadBps} bps</td><td className="r num" style={{ color: failures.spread ? "var(--down)" : undefined }}>{failures.spread}</td><td className="r num">{observed.spreadMedian === null ? "—" : `${observed.spreadMedian} bps`}</td></tr>
          </tbody>
        </table>
      </div>
      <span className="xs muted">Depth measured in the reference bin and the whole bins within {terms.depthWindowBps} bps of it, with the Mandate program&apos;s arithmetic; spread at a tenth of the minimum depth.</span>
    </div>
  );
}

export function ExecutionTable({ rows, quote }: { rows: ExecutionStat[]; quote: string }) {
  const pct = (x: number | null) => (x === null ? <span className="faint">no liquidity</span> : `${(x * 100).toFixed(2)}%`);
  if (!rows.length) return null;
  if (rows.every((r) => r.samples === 0)) return <span className="small muted">No measured samples yet.</span>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="table-wrap">
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th>Trade size</th><th className="r">Buy: median / worst</th><th className="r">Sell: median / worst</th><th className="r">Couldn&apos;t fill <InfoTip>Samples where the operator&apos;s book alone couldn&apos;t fill this size on one side.</InfoTip></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.size}>
                <td className="num">{r.size.toLocaleString("en-US")} {quote}</td>
                <td className="r num">{pct(r.buyMedian)} / {pct(r.buyWorst)}</td>
                <td className="r num">{pct(r.sellMedian)} / {pct(r.sellWorst)}</td>
                <td className="r num" style={{ color: r.unfilled ? "var(--warn)" : undefined }}>{r.unfilled} of {r.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="xs muted">Trader experience, estimated from the operator&apos;s own book before swap fees; other liquidity on the pair makes it cheaper. Shown separately because a book can meet committed-depth terms while trading through it is still expensive.</span>
    </div>
  );
}
