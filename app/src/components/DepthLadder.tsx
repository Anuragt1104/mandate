"use client";

import { useState } from "react";
import type { BookBin } from "@/lib/chain";
import { fmt, fmtPrice } from "./ui";

/**
 * The mandate's own quotes, drawn like an order-book ladder, one row per DLMM bin. Each
 * bin holds base (an ask) or quote (a bid) depending on where the price has been. The
 * band inside which the vault may quote is shaded, and the reference price is ruled:
 * the vault may only bid at or below it and offer above it.
 */
export function DepthLadder({
  bins,
  activeBinId,
  refBin,
  refUi,
  bandBps,
  quoteSymbol = "quote",
}: {
  bins: BookBin[];
  activeBinId: number;
  refBin: number;
  refUi: number;
  bandBps: number;
  quoteSymbol?: string;
}) {
  const [hover, setHover] = useState<BookBin | null>(null);
  if (!bins.length) return <div className="empty">No liquidity deployed yet. The market maker has not quoted this market.</div>;

  const rows = [...bins].sort((a, b) => b.binId - a.binId);
  const value = (b: BookBin) => b.quote + b.base * b.priceUi;
  const max = Math.max(...rows.map(value), 1e-12);
  const rowH = 14;
  const labelW = 110;
  const width = 560;
  const barW = width - labelW - 70;
  const height = rows.length * rowH + 8;
  const lo = refUi * (1 - bandBps / 10_000);
  const hi = refUi * (1 + bandBps / 10_000);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 420, display: "block" }} role="img"
          aria-label={`Order ladder with ${rows.length} bins around active bin ${activeBinId}`}>
          {rows.map((b, i) => {
            const y = 4 + i * rowH;
            const inBand = b.priceUi >= lo && b.priceUi <= hi;
            const isActive = b.binId === activeBinId;
            const askV = b.base * b.priceUi;
            const bidV = b.quote;
            const askW = (askV / max) * barW;
            const bidW = (bidV / max) * barW;
            return (
              <g key={b.binId} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)}>
                <rect x={0} y={y} width={width} height={rowH} fill={inBand ? "var(--band)" : "transparent"} />
                {isActive && <rect x={0} y={y} width={width} height={rowH} fill="none" stroke="var(--brass)" strokeWidth={1.2} rx={2} />}
                <text x={labelW - 8} y={y + rowH - 3.5} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-2)">
                  {fmtPrice(b.priceUi)}
                </text>
                {askW > 0 && <rect x={labelW} y={y + 2} width={Math.max(askW, 1.5)} height={rowH - 4} rx={2} fill="var(--ask)" />}
                {bidW > 0 && <rect x={labelW + askW} y={y + 2} width={Math.max(bidW, 1.5)} height={rowH - 4} rx={2} fill="var(--bid)" />}
                <rect x={0} y={y} width={width} height={rowH} fill="transparent" />
              </g>
            );
          })}
          {(() => {
            // Rule between the lowest ask-side bin (refBin + 1) and the reference bin.
            const i = rows.findIndex((r) => r.binId <= refBin);
            if (i < 0) return null;
            const y = 4 + i * rowH;
            return (
              <g>
                <line x1={0} x2={width} y1={y} y2={y} stroke="var(--brass)" strokeWidth={1.5} strokeDasharray="4 3" />
                <rect x={width - 118} y={y - 7} width={116} height={14} rx={3} fill="var(--panel)" stroke="var(--brass)" strokeWidth={1} />
                <text x={width - 60} y={y + 3.5} textAnchor="middle" fontSize={9.5} fontFamily="var(--font-display)" fontWeight={600} fill="var(--brass)">
                  reference {fmtPrice(refUi)}
                </text>
              </g>
            );
          })()}
        </svg>
      </div>
      <div className="tape-legend" style={{ marginTop: 8 }}>
        <span><i style={{ background: "var(--ask)" }} />Asks (base, valued in {quoteSymbol})</span>
        <span><i style={{ background: "var(--bid)" }} />Bids ({quoteSymbol})</span>
        <span><i style={{ background: "var(--band)", border: "1px solid var(--brass)" }} />Allowed band ±{bandBps / 100}% of reference</span>
        <span><i style={{ borderTop: "1.5px dashed var(--brass)", height: 0 }} />Reference price</span>
        <span><i style={{ border: "1.5px solid var(--brass)" }} />Active bin</span>
      </div>
      {hover && (
        <div className="mono" style={{ marginTop: 6, color: "var(--ink-2)" }}>
          bin {hover.binId} · price {fmtPrice(hover.priceUi)} · asks {fmt(hover.base, 0)} base (≈{fmt(hover.base * hover.priceUi)} {quoteSymbol}) · bids {fmt(hover.quote)} {quoteSymbol}
        </div>
      )}
    </div>
  );
}
