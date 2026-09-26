import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import study from "../../public/study.json";
import { Footer, MarketingNav, SECURITY_URL } from "@/components/nav";
import { NetworkHero } from "@/components/live";
import { HBars } from "@/components/charts";
import { Schedule } from "@/components/sla";

const s = study.summary;
const hist = study.histogram.all as { label: string; count: number }[];
const pools = hist.reduce((a, b) => a + b.count, 0);
const underCent = hist[0].count / pools;

/** The terms every SLA on the test network uses, shown as the example agreement. */
const EXAMPLE_TERMS = {
  minDepthQuote: 500e6, depthWindowBps: 200, maxSpreadBps: 100, bandBps: 500, anchorTwapSecs: 120, anchorSpeedBpsPerMin: 200,
  feePerPeriod: 0.5e6, periodSecs: 60, durationPeriods: 10_080, maxConsecutiveFailures: 3, slashBps: 5_000, bondAmount: 250e6, liquidityLockSecs: 20,
};

const ENFORCEMENT = [
  { title: "Committed depth, measured bin by bin", body: "A check values the maker's liquidity at each price bin's own price. Buying out the book right before a check moves value between the two tokens, not out of the book, so it can't fake a pass or force a fail." },
  { title: "Checks nobody can schedule around", body: "Anyone can run a check at any moment, as often as they like. The maker can't know when the next one lands, so the only strategy is to stay in the market." },
  { title: "A reference price you can't push", body: "Quotes are judged against a reference that follows the pair's time-weighted price at a capped speed. A price moved for one block doesn't move it." },
  { title: "Escrow with one exit", body: "The issuer's inventory can only be quoted on the pair and returns at the end of the term. Fees stream out per compliant period; the bond is slashed on breach." },
];

const INCIDENTS = [
  {
    title: "Sandwiched check",
    attempt: "Mallory buys out the maker's asks and forces a check in the same transaction, hoping the lopsided book flatters or fails the maker.",
    outcome: "Check passed",
    tone: "up",
    why: "Liquidity is valued bin by bin at each bin's price, so the trade changes which token sits in a bin, not how much is committed.",
  },
  {
    title: "Maker walks away",
    attempt: "Lazy Capital accepts KITE's SLA, quotes for a few minutes, then pulls every bin back into the vault.",
    outcome: "Bond slashed",
    tone: "down",
    why: "Checks fail, three missed periods slash half its bond, the inventory goes back to the issuer, and KITE re-tenders to a new maker.",
  },
  {
    title: "Reference nudge",
    attempt: "Push the pair's price for a block so the maker's quotes look off-side, or drag the reference toward a price that suits you.",
    outcome: "No effect",
    tone: "up",
    why: "The reference tracks the pair's TWAP at no more than 2% a minute and distrusts oracle time after an emptied bin.",
  },
  {
    title: "Quote for the check, pull after",
    attempt: "Add liquidity just before a check lands and withdraw it straight after, so the book is only deep when someone looks.",
    outcome: "Blocked",
    tone: "up",
    why: "Deposits are locked for 20 seconds and checks arrive at random, so liquidity has to stay to count.",
  },
];

const PARTIES = [
  {
    title: "Launchpads",
    lede: "Turn leftover launch supply into a funded agreement.",
    points: ["Route a graduating token's unsold supply straight into an agreement's escrow as inventory", "Pair it with a quote deposit, a fee budget and a maker you vet", "Publish a status page for every token under agreement"],
  },
  {
    title: "Token teams",
    lede: "Keep your operator, lose the blind trust.",
    points: ["Inventory can only be quoted, then comes back", "Pay per verified period instead of settling an invoice by hand", "A breach penalises the bond and returns the inventory"],
  },
  {
    title: "Market makers",
    lede: "Get paid on a record nobody can dispute.",
    points: ["Every period you meet is written to your profile", "Payment is automatic once the terms are met", "Terms are fixed up front: bond, fee, penalty, term, no surprises"],
  },
];

export default function Landing() {
  return (
    <>
      <MarketingNav />
      <main>
        <NetworkHero />

        <section id="contract" className="section">
          <div className="container">
            <div className="section-head">
              <span className="kicker">The agreement</span>
              <h2 className="h2">The terms both sides agree to, enforced by the program.</h2>
              <p className="body-lg">
                Monitoring a market maker is not new; dashboards and reports exist. What changes is custody and settlement: the inventory can
                only be used for quoting, and payment and penalties follow the checks automatically instead of by invoice.
              </p>
            </div>
            <div className="contract">
              <div className="contract-col">
                <div className="row-between"><span className="h3">Example: the KITE/USDC SLA</span><span className="xs muted mono">test network terms</span></div>
                <Schedule t={EXAMPLE_TERMS} quote="USDC" decimals={6} />
              </div>
              <div className="contract-col">
                <span className="h3">How each clause holds</span>
                {ENFORCEMENT.map((e) => (
                  <div className="enforce" key={e.title}>
                    <h4>{e.title}</h4>
                    <p>{e.body}</p>
                  </div>
                ))}
                <a className="link small" href={SECURITY_URL} target="_blank" rel="noreferrer">Read the security model</a>
              </div>
            </div>
          </div>
        </section>

        <section className="section tight" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="contract">
              <div className="contract-col">
                <span className="eyebrow">Enforced</span>
                <span className="h3" style={{ fontSize: 18 }}>Committed liquidity near the reference price</span>
                <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                  Where the manager placed the inventory, valued bin by bin. Trades move value between the two tokens inside a bin, not out
                  of the book, so nobody can fail an honest manager by buying out its asks, or rescue a negligent one.
                </p>
              </div>
              <div className="contract-col">
                <span className="eyebrow">Shown, not enforced</span>
                <span className="h3" style={{ fontSize: 18 }}>What a trader gets right now</span>
                <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                  Execution cost at several trade sizes and routability, on every status page. These move with every trade, which is why they
                  can&apos;t be the obligation. When a side is drained, the manager has to re-quote it before the reference price catches up, or
                  that side starts counting as missing.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="incidents" className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-head">
              <span className="kicker">Incident log</span>
              <h2 className="h2">We attacked it the way a bad actor would. Here is what happened.</h2>
              <p className="body-lg">
                These run on the test network around the clock, played by simulated participants making real transactions. Watch them in the network&apos;s activity feed.
              </p>
            </div>
            <div className="incidents">
              {INCIDENTS.map((i) => (
                <div className="incident" key={i.title}>
                  <div style={{ display: "grid", gap: 10, justifyItems: "start" }}>
                    <h3>{i.title}</h3>
                    <span className={`chip ${i.tone}`}><span className="dot" />{i.outcome}</span>
                  </div>
                  <div><span className="eyebrow">Attempt</span><p style={{ marginTop: 6 }}>{i.attempt}</p></div>
                  <div className="outcome"><span className="eyebrow">Why</span><p>{i.why}</p></div>
                </div>
              ))}
            </div>
            <div className="row wrap" style={{ marginTop: 18 }}>
              <Link className="btn btn-secondary" href="/app/agreements">Watch the live feed <ArrowRight /></Link>
            </div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-head">
              <span className="kicker">Who it&apos;s for</span>
              <h2 className="h2">One agreement, three parties who can finally agree on the facts.</h2>
            </div>
            <div className="parties">
              {PARTIES.map((p) => (
                <div className="party-card" key={p.title}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <h3>{p.title}</h3>
                    <p className="muted" style={{ margin: 0, fontSize: 15 }}>{p.lede}</p>
                  </div>
                  <ul>{p.points.map((pt) => <li key={pt}><Check />{pt}</li>)}</ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container evidence">
            <div style={{ display: "grid", gap: 18 }}>
              <span className="kicker">Exploratory research</span>
              <div className="stat-big">{Math.round(underCent * 100)}%</div>
              <p className="body-lg" style={{ maxWidth: "46ch" }}>
                of {pools.toLocaleString("en-US")} newly graduated launchpad pools on Solana couldn&apos;t absorb one cent of trading without the price moving 2%.
                Even pools that traded over $10,000 in a day held a median of ${s.volume24hAtLeast10k.medianDepth2pctUsd.toFixed(3)} of depth.
              </p>
              <p className="small muted" style={{ margin: 0, maxWidth: "46ch" }}>
                A snapshot, not a market size: a thin pool can mean a neglected market, missing quote capital or simply no demand. It shows
                where the problem appears; the customers are funded teams that already pay for liquidity.
              </p>
              <Link className="link small" href="/research">How we measured it</Link>
            </div>
            <div className="card card-pad" style={{ display: "grid", gap: 16 }}>
              <div className="row-between wrap">
                <span className="h3">Two-sided depth within ±2%</span>
                <span className="xs muted mono">{pools.toLocaleString("en-US")} pools · Sep 2026</span>
              </div>
              <HBars buckets={hist} />
              <span className="xs muted">Computed from each pool&apos;s on-chain liquidity and price, not reported volume.</span>
            </div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="closing">
              <div style={{ display: "grid", gap: 12 }}>
                <h2 className="h2">Put your liquidity operator under an agreement.</h2>
                <p>Watch the test network, read an agreement in plain words, or draft terms for your own token and operator in a couple of minutes.</p>
              </div>
              <div className="row wrap">
                <Link className="btn btn-primary btn-lg" href="/app">Open the app <ArrowRight /></Link>
                <Link className="btn btn-secondary btn-lg" href="/app/create">Draft an agreement</Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
