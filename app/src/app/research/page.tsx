import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import study from "../../../public/study.json";
import { Footer, MarketingNav, REPO_URL } from "@/components/nav";
import { HBars } from "@/components/charts";

export const metadata: Metadata = { title: "How liquid are new Solana tokens?" };

const s = study.summary;
const date = new Date(s.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const all = study.histogram.all as { label: string; count: number }[];
const activeHist = study.histogram.volume24hAtLeast10k as { label: string; count: number }[];
const usd = (n: number, d = 3) => `$${n.toFixed(d)}`;
const byLaunchpad = Object.entries(s.byLaunchpad as Record<string, any>).sort((a, b) => b[1].pools - a[1].pools);

export default function Research() {
  const underCent = all[0].count / all.reduce((a, b) => a + b.count, 0);
  return (
    <>
      <MarketingNav />
      <main>
        <section className="section" style={{ paddingBottom: 48 }}>
          <div className="container" style={{ display: "grid", gap: 20, maxWidth: 880 }}>
            <span className="kicker">Research · {date}</span>
            <h1 className="display" style={{ fontSize: "clamp(34px, 5vw, 56px)" }}>How liquid are new Solana tokens?</h1>
            <p className="lead">
              We measured how much a trader could buy or sell before moving the price 2% in the {s.poolsScanned.toLocaleString("en-US")} newest
              Meteora DAMM v2 pools, the pools launchpad tokens graduate into. Depth comes from each pool&apos;s on-chain liquidity, not reported volume.
            </p>
          </div>
        </section>

        <section className="container" style={{ maxWidth: 1080 }}>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            <div className="kpi"><div className="kpi-label">Pools measured</div><div className="kpi-value">{s.all.pools.toLocaleString("en-US")}</div><div className="kpi-sub">of {s.poolsScanned.toLocaleString("en-US")} scanned</div></div>
            <div className="kpi"><div className="kpi-label">Median ±2% depth</div><div className="kpi-value">{usd(s.all.medianDepth2pctUsd)}</div><div className="kpi-sub">two-sided minimum</div></div>
            <div className="kpi"><div className="kpi-label">Holding ≥ $1,000</div><div className="kpi-value">{s.tvlAtLeast1k.pools}</div><div className="kpi-sub">pools, total value locked</div></div>
            <div className="kpi"><div className="kpi-label">Can&apos;t absorb one cent</div><div className="kpi-value">{(underCent * 100).toFixed(1)}%</div><div className="kpi-sub">within ±2%</div></div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 56 }}>
          <div className="container grid-halves" style={{ maxWidth: 1080, gap: 24 }}>
            <div className="card card-pad" style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gap: 4 }}>
                <span className="h3">All measured pools</span>
                <span className="small muted">Number of pools by two-sided depth within ±2% (USD)</span>
              </div>
              <HBars buckets={all} />
            </div>
            <div className="card card-pad" style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gap: 4 }}>
                <span className="h3">Pools that traded over $10,000 in 24 hours</span>
                <span className="small muted">Tokens with real activity are no deeper</span>
              </div>
              <HBars buckets={activeHist} />
              <span className="small muted">
                Median 24h volume ${Math.round(s.volume24hAtLeast10k.medianVolume24hUsd).toLocaleString("en-US")} against a median depth of{" "}
                {usd(s.volume24hAtLeast10k.medianDepth2pctUsd)}. Volume arrives, trades once against the curve, and the book is empty again.
              </span>
            </div>
          </div>

          <div className="container" style={{ maxWidth: 1080, marginTop: 24 }}>
            <div className="card">
              <div className="card-head"><span className="h3">By launchpad</span><span className="xs muted">Median values per launchpad</span></div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Launchpad</th><th className="r">Pools</th><th className="r">Median TVL</th><th className="r">Median ±2% depth</th><th className="r">Share under $100 depth</th></tr>
                  </thead>
                  <tbody>
                    {byLaunchpad.map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ fontWeight: 580 }}>{k}</td>
                        <td className="r num">{v.pools.toLocaleString("en-US")}</td>
                        <td className="r num">${v.medianTvlUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                        <td className="r num">{usd(v.medianDepth2pctUsd)}</td>
                        <td className="r num">{(100 * v.shareDepthBelow100Usd).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="container" style={{ maxWidth: 1080, marginTop: 48, display: "grid", gap: 16 }}>
            <h2 className="h2" style={{ fontSize: 26 }}>Method</h2>
            <div className="prose">
              <p>Pools were discovered newest-first through Meteora&apos;s public DAMM v2 data API. Only pools with a launchpad and a USDC or SOL quote were valued.</p>
              <p>
                For each pool we read <code>liquidity</code> and <code>sqrt_price</code> from its mainnet account and computed the quote needed to move
                the price 2% each way: Δquote = L·(√P₂ − √P₁)/2¹²⁸, clamped to the pool&apos;s price range. Depth is the smaller of the bid and ask
                side, converted to USD with the quote token&apos;s price.
              </p>
              <p>
                Limits. This is one snapshot of recently created pools, most of them days old, on one venue. It says nothing about a
                token&apos;s liquidity on other venues, about whether a team has a budget, or whether anyone wants to trade it: a thin pool can
                mean a neglected market, missing quote capital, or no demand. Some pools pair large trailing 24-hour volume with almost no
                current depth, which fits liquidity that was withdrawn after trading; that pattern needs a time series, not a snapshot, before
                drawing conclusions. Treat the numbers as where the problem shows, not as a count of buyers.
              </p>
              <p>Reproduce it with <code>npx tsx scripts/liquidity-study.ts --pages 30</code> from the <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">repository</a>.</p>
            </div>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <Link className="btn btn-primary" href="/app">See a token with a market maker under contract <ArrowRight /></Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
