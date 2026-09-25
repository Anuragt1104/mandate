"use client";

import { useMemo, useState } from "react";
import type { BookBin } from "@/lib/chain";
import { Tip, fmt, fmtPrice } from "./ui";

// ---------------------------------------------------------------- liquidity chart

/**
 * The vault's DLMM position, one bar per price bin. Quote (bids) and base valued in quote
 * (asks) are stacked; the dashed line is the reference price the program enforces: bids
 * sit at or below it, asks above it. The shaded region is the depth window the checks count.
 */
export function LiquidityChart({
  bins,
  refBin,
  activeBin,
  binStep,
  refUi,
  depthWindowBps,
  quoteSymbol = "quote",
  baseSymbol = "base",
  height = 230,
  maxBins = 64,
}: {
  bins: BookBin[];
  refBin: number;
  activeBin: number;
  binStep: number;
  refUi: number;
  depthWindowBps: number;
  quoteSymbol?: string;
  baseSymbol?: string;
  height?: number;
  maxBins?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const byId = useMemo(() => new Map(bins.map((b) => [b.binId, b])), [bins]);

  const withLiq = bins.filter((b) => b.base > 0 || b.quote > 0).map((b) => b.binId);
  const half = Math.floor(maxBins / 2);
  let lo = Math.min(refBin - 12, withLiq.length ? Math.min(...withLiq) : refBin - 12);
  let hi = Math.max(refBin + 13, withLiq.length ? Math.max(...withLiq) : refBin + 13);
  if (hi - lo + 1 > maxBins) {
    lo = Math.max(lo, refBin - half + 1);
    hi = lo + maxBins - 1;
  }
  const ids: number[] = [];
  for (let b = lo; b <= hi; b++) ids.push(b);

  const priceOf = (id: number) => refUi * Math.pow(1 + binStep / 10_000, id - refBin);
  const value = (b?: BookBin) => (b ? b.quote + b.base * b.priceUi : 0);
  const max = Math.max(...ids.map((id) => value(byId.get(id))), 1e-12);

  const W = 640;
  const H = height;
  const padT = 30;
  const padB = 30;
  const plotH = H - padT - padB;
  const slot = W / ids.length;
  const gap = Math.min(2, slot * 0.18);
  const x = (id: number) => (id - lo) * slot;
  const windowBins = Math.ceil(depthWindowBps / Math.max(1, binStep));
  const winLo = Math.max(lo, refBin - windowBins);
  const winHi = Math.min(hi, refBin + 1 + windowBins);
  const refX = x(refBin) + slot;
  const tickEvery = Math.max(1, Math.round(ids.length / 6));
  const hovered = hover !== null ? byId.get(hover) : undefined;

  if (!withLiq.length) {
    return (
      <div className="empty-state" style={{ height }}>
        <span className="h3" style={{ color: "var(--ink)" }}>No liquidity deployed yet</span>
        <span className="small">The market maker has not placed the vault&apos;s inventory on the pair.</span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" style={{ display: "block", overflow: "visible" }}
        aria-label={`Liquidity by price bin. Reference price ${fmtPrice(refUi)} ${quoteSymbol}.`}>
        {/* depth window */}
        <rect x={x(winLo)} y={padT - 6} width={x(winHi) + slot - x(winLo)} height={plotH + 6} fill="var(--band)" />
        {/* grid */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="var(--grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {/* bars */}
        {ids.map((id, i) => {
          const b = byId.get(id);
          const q = b ? b.quote : 0;
          const a = b ? b.base * b.priceUi : 0;
          const hq = (q / max) * plotH;
          const ha = (a / max) * plotH;
          const bx = x(id) + gap / 2;
          const bw = Math.max(1, slot - gap);
          const dim = hover !== null && hover !== id ? 0.45 : 1;
          return (
            <g key={id} opacity={dim} style={{ transition: "opacity 0.15s" }}>
              {hq > 0 && <rect className="bar-in" style={{ animationDelay: `${i * 8}ms` }} x={bx} y={padT + plotH - hq} width={bw} height={hq} rx={Math.min(2, bw / 3)} fill="var(--bid)" />}
              {ha > 0 && <rect className="bar-in" style={{ animationDelay: `${i * 8}ms` }} x={bx} y={padT + plotH - hq - ha} width={bw} height={ha} rx={Math.min(2, bw / 3)} fill="var(--ask)" />}
              {id === activeBin && <path d={`M ${x(id) + slot / 2 - 4} ${H - padB + 9} l 4 -5 l 4 5 z`} fill="var(--ink)" />}
            </g>
          );
        })}
        {/* baseline */}
        <line x1={0} x2={W} y1={padT + plotH} y2={padT + plotH} stroke="var(--line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {/* reference line */}
        <line x1={refX} x2={refX} y1={padT - 14} y2={padT + plotH} stroke="var(--brand)" strokeWidth={1.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        {/* hover targets */}
        {ids.map((id) => (
          <rect key={`h${id}`} x={x(id)} y={0} width={slot} height={H - padB} fill="transparent" onMouseEnter={() => setHover(id)} />
        ))}
      </svg>
      {/* labels drawn in HTML so they stay crisp at any width */}
      <div style={{ position: "absolute", left: `${(refX / W) * 100}%`, top: 0, transform: "translateX(-50%)", pointerEvents: "none" }}>
        <span className="tag" style={{ background: "var(--brand)", color: "var(--brand-ink)", height: 20, fontSize: 11.5 }}>
          Reference {fmtPrice(refUi)}
        </span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 16, pointerEvents: "none" }}>
        {ids.filter((_, i) => i % tickEvery === 0).map((id) => (
          <span key={id} className="xs faint num" style={{ position: "absolute", left: `${((x(id) + slot / 2) / W) * 100}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" }}>
            {pctLabel(priceOf(id) / refUi - 1)}
          </span>
        ))}
      </div>
      {hover !== null && (
        <div className="chart-tooltip" style={{ left: `${((x(hover) + slot / 2) / W) * 100}%`, top: padT }}>
          <div><b>{fmtPrice(priceOf(hover))}</b> {quoteSymbol} per {baseSymbol} <span className="faint">({pctLabel(priceOf(hover) / refUi - 1)})</span></div>
          <div>Bids: <b>{fmt(hovered?.quote ?? 0)}</b> {quoteSymbol}</div>
          <div>Asks: <b>{fmt(hovered?.base ?? 0, 0)}</b> {baseSymbol} (≈{fmt((hovered?.base ?? 0) * (hovered?.priceUi ?? 0))} {quoteSymbol})</div>
          <div className="faint">{hover <= refBin ? "Bid side of the reference" : "Ask side of the reference"}{hover === activeBin ? " · active bin" : ""}</div>
        </div>
      )}
    </div>
  );
}

function pctLabel(f: number) {
  const p = f * 100;
  if (Math.abs(p) < 0.05) return "ref";
  return `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(Math.abs(p) < 0.1 ? 2 : 1)}%`;
}

export function LiquidityLegend({ quoteSymbol, windowBps }: { quoteSymbol: string; windowBps: number }) {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--bid)" }} />Bids ({quoteSymbol})</span>
      <span><i style={{ background: "var(--ask)" }} />Asks (valued in {quoteSymbol})</span>
      <span><i className="swatch line" style={{ width: 14 }} />Reference price</span>
      <span><i style={{ background: "var(--band)", boxShadow: "inset 0 0 0 1px var(--line-2)" }} />Counted window ±{windowBps / 100}%</span>
      <span><svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true"><path d="M0 8 L5 1 L10 8 z" fill="var(--ink)" /></svg>Active bin</span>
    </div>
  );
}

// ---------------------------------------------------------------- compliance tape

export interface PeriodEntry {
  period: number;
  status: number; // 1 ok, 2 failed, 3 unobserved
  snapshots: number;
  worstSpreadBps: number;
  minBidDepth: any;
  minAskDepth: any;
}

const STATUS_TEXT: Record<number, string> = { 1: "Compliant", 2: "Failed", 3: "Not observed" };

/** One cell per scoring period, like an uptime history on a status page. */
export function ComplianceTape({
  entries,
  live,
  total,
  cells = 60,
  size = "md",
  quoteDecimals = 6,
  quoteSymbol = "",
}: {
  entries: PeriodEntry[];
  live?: { period: number; failed: boolean; snapshots: number } | null;
  total?: number;
  cells?: number;
  size?: "sm" | "md" | "lg";
  quoteDecimals?: number;
  quoteSymbol?: string;
}) {
  const shown = entries.slice(-Math.max(0, cells - (live ? 1 : 0)));
  const used = shown.length + (live ? 1 : 0);
  const lastPeriod = live ? live.period : (shown.at(-1)?.period ?? -1);
  const remaining = total ? Math.max(0, total - lastPeriod - 1) : 0;
  const future = Math.min(remaining, Math.max(0, cells - used));
  const cls = (s: number) => (s === 1 ? "ok" : s === 2 ? "failed" : s === 3 ? "unobserved" : "");
  const q = (v: any) => Number(v?.toString?.() ?? v) / 10 ** quoteDecimals;
  const withTips = size !== "sm";

  const cell = (e: PeriodEntry) => {
    const el = <span className={`tape-cell ${cls(e.status)}`} tabIndex={withTips ? 0 : -1} aria-label={`Period ${e.period + 1}: ${STATUS_TEXT[e.status]}`} />;
    if (!withTips) return <span key={e.period} className={`tape-cell ${cls(e.status)}`} />;
    return (
      <Tip key={e.period} className="tape-cell-wrap" content={
        <span style={{ display: "grid", gap: 2 }}>
          <b>Period {e.period + 1} · {STATUS_TEXT[e.status]}</b>
          {e.status === 3 ? (
            <span>Nobody checked the quotes this period, so it is neither paid nor failed.</span>
          ) : (
            <>
              <span>{e.snapshots} check{e.snapshots === 1 ? "" : "s"}</span>
              <span>Widest spread {e.worstSpreadBps === 65535 ? "one side empty" : `${e.worstSpreadBps} bps`}</span>
              <span>Lowest bids {fmt(q(e.minBidDepth))} {quoteSymbol} · asks {fmt(q(e.minAskDepth))} {quoteSymbol}</span>
            </>
          )}
        </span>
      }>
        {el}
      </Tip>
    );
  };

  return (
    <div className={`tape ${size}`} role="img" aria-label={`${entries.filter((e) => e.status === 1).length} compliant, ${entries.filter((e) => e.status === 2).length} failed, ${entries.filter((e) => e.status === 3).length} unobserved periods`}>
      {shown.map(cell)}
      {live && (withTips ? (
        <Tip className="tape-cell-wrap" content={<span style={{ display: "grid", gap: 2 }}><b>Period {live.period + 1} · In progress</b><span>{live.snapshots} check{live.snapshots === 1 ? "" : "s"} so far{live.failed ? ", at least one failed" : ", all passed"}</span></span>}>
          <span className={`tape-cell live ${live.failed ? "bad" : ""}`} tabIndex={0} aria-label="Current period" />
        </Tip>
      ) : <span className={`tape-cell live ${live.failed ? "bad" : ""}`} />)}
      {Array.from({ length: future }).map((_, i) => <span key={`f${i}`} className="tape-cell future" />)}
    </div>
  );
}

export function TapeLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--pass)" }} />Compliant</span>
      <span><i style={{ background: "var(--fail)" }} />Failed</span>
      <span><i style={{ background: "var(--idle)" }} />Not observed</span>
      <span><i style={{ background: "repeating-linear-gradient(135deg, var(--pass) 0 2px, transparent 2px 4px)", boxShadow: "inset 0 0 0 1px var(--pass)" }} />In progress</span>
    </div>
  );
}

// ---------------------------------------------------------------- horizontal histogram

export function HBars({ buckets, hotFirst = true, unit = "pools" }: { buckets: { label: string; count: number }[]; hotFirst?: boolean; unit?: string }) {
  const total = buckets.reduce((s, b) => s + b.count, 0) || 1;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div className="hbars" role="img" aria-label={buckets.map((b) => `${b.label}: ${b.count} ${unit}`).join(", ")}>
      {buckets.map((b, i) => (
        <div className="hbar" key={b.label}>
          <span className="mono muted" style={{ textAlign: "right" }}>{b.label}</span>
          <span className="hbar-track"><span className={`hbar-fill ${hotFirst && i === 0 ? "hot" : ""}`} style={{ width: `${(b.count / max) * 100}%`, minWidth: b.count ? 3 : 0 }} /></span>
          <span className="num small"><b>{b.count.toLocaleString("en-US")}</b> <span className="muted">({((100 * b.count) / total).toFixed(1)}%)</span></span>
        </div>
      ))}
    </div>
  );
}
