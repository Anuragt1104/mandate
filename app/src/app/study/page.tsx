"use client";

import { useEffect, useState } from "react";
import { fmt } from "@/components/ui";

type Bucket = { label: string; count: number };

function Histogram({ buckets, title }: { buckets: Bucket[]; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = buckets.reduce((s, b) => s + b.count, 0) || 1;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{title}</figcaption>
      <div role="img" aria-label={`${title}: ${buckets.map((b) => `${b.label} ${b.count}`).join(", ")}`} style={{ display: "grid", gap: 6 }}>
        {buckets.map((b, i) => (
          <div key={b.label} style={{ display: "grid", gridTemplateColumns: "90px 1fr 90px", alignItems: "center", gap: 10 }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="mono muted" style={{ textAlign: "right" }}>{b.label}</span>
            <span style={{ background: "var(--panel-2)", borderRadius: 3, height: 18, position: "relative" }}>
              <span style={{ position: "absolute", inset: 0, width: `${(b.count / max) * 100}%`, minWidth: b.count ? 2 : 0, background: i === 0 ? "var(--fail)" : "var(--ask)", borderRadius: 3, opacity: hover === null || hover === i ? 1 : 0.55 }} />
            </span>
            <span className="num" style={{ fontSize: 14 }}>{b.count} <span className="muted" style={{ fontWeight: 400 }}>({((100 * b.count) / total).toFixed(1)}%)</span></span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export default function Study() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    fetch("/study.json").then((r) => r.json()).then(setD).catch(() => setD(false));
  }, []);
  if (d === false) return <div className="empty" style={{ marginTop: 40 }}>Study data not found. Run <span className="mono">npx tsx scripts/liquidity-study.ts</span>.</div>;
  if (!d) return <div className="empty" style={{ marginTop: 40 }}>Loading study…</div>;
  const s = d.summary;
  const active = s.volume24hAtLeast10k;
  const date = new Date(s.generatedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Liquidity study · {date}</span>
        <h1>How liquid are new Solana tokens?</h1>
        <p className="lede">
          We measured how much a trader could buy or sell before moving the price 2% in the {fmt(s.poolsScanned, 0)} newest Meteora DAMM v2
          pools, the pools launchpad tokens graduate into. Depth is computed from each pool&apos;s on-chain liquidity, not from reported volume.
        </p>
      </section>

      <div className="stats">
        <div className="stat"><div className="label">Pools measured</div><div className="value">{fmt(s.all.pools, 0)}</div></div>
        <div className="stat"><div className="label">Still holding ≥ $1K</div><div className="value">{s.tvlAtLeast1k.pools}</div></div>
        <div className="stat"><div className="label">Median ±2% depth</div><div className="value">${s.all.medianDepth2pctUsd.toFixed(3)}</div></div>
        <div className="stat"><div className="label">Traded ≥ $10K in 24h</div><div className="value">{active.pools}</div></div>
        <div className="stat"><div className="label">…their median depth</div><div className="value">${active.medianDepth2pctUsd.toFixed(3)}</div></div>
      </div>

      <div className="grid-2">
        <section className="panel stack">
          <h2>Depth within ±2%, all measured pools</h2>
          <Histogram buckets={d.histogram.all} title="Number of pools by two-sided ±2% depth (USD)" />
        </section>
        <section className="panel stack">
          <h2>Pools that traded ≥ $10K in 24h</h2>
          <Histogram buckets={d.histogram.volume24hAtLeast10k} title="Tokens with real trading activity are no deeper" />
          <p className="hint">Median 24h volume {fmt(active.medianVolume24hUsd, 0)} USD against a median depth of ${active.medianDepth2pctUsd.toFixed(3)}. Volume arrives, trades once against the curve, and the book is empty again.</p>
        </section>
      </div>

      <section className="panel">
        <h2 style={{ marginBottom: 10 }}>By launchpad</h2>
        <div className="board-wrap">
          <table className="board">
            <thead><tr><th>Launchpad</th><th className="right">Pools</th><th className="right">Median TVL</th><th className="right">Median ±2% depth</th><th className="right">Depth under $100</th></tr></thead>
            <tbody>
              {Object.entries(s.byLaunchpad).map(([k, v]: any) => (
                <tr key={k} style={{ cursor: "default" }}>
                  <td className="num">{k}</td>
                  <td className="right num">{v.pools}</td>
                  <td className="right num">${fmt(v.medianTvlUsd)}</td>
                  <td className="right num">${v.medianDepth2pctUsd.toFixed(3)}</td>
                  <td className="right num">{(100 * v.shareDepthBelow100Usd).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2 style={{ marginBottom: 10 }}>Method</h2>
        <ul className="lede" style={{ fontSize: 14, margin: 0, paddingLeft: 18 }}>
          <li>Pools discovered newest-first through Meteora&apos;s public DAMM v2 data API; only pools with a launchpad and a USDC or SOL quote are valued.</li>
          <li>For each pool we read <span className="mono">liquidity</span> and <span className="mono">sqrt_price</span> from its on-chain account and compute the quote needed to move the price 2% each way: Δquote = L·(√P₂ − √P₁)/2¹²⁸, clamped to the pool&apos;s price range.</li>
          <li>Depth is the smaller of the bid and ask side, converted to USD with the quote token&apos;s price.</li>
          <li>Reproduce: <span className="mono">npx tsx scripts/liquidity-study.ts --pages 30</span></li>
        </ul>
      </section>
    </div>
  );
}
