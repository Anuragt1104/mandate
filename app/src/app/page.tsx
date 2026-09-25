import Link from "next/link";
import { ArrowRight, Building2, Check, Crosshair, Eye, Layers, Lock, Rocket, Scale, ShieldCheck, Vault, Activity } from "lucide-react";
import study from "../../public/study.json";
import { Footer, GithubMark, MarketingNav, REPO_URL, SECURITY_URL } from "@/components/nav";
import { LiveContract } from "@/components/live";
import { HBars } from "@/components/charts";
import { CommitArt, EscrowArt, SettleArt, VerifyArt } from "@/components/steps-art";

const s = study.summary;
const hist = study.histogram.all as { label: string; count: number }[];
const pools = hist.reduce((a, b) => a + b.count, 0);
const underCent = hist[0].count / pools;

const STEPS = [
  {
    title: "Escrow the inventory",
    body: "The issuer or launchpad funds a program-owned vault with tokens and a fee budget. With a Mandated bonding-curve config, a token's unsold supply is routed there automatically at graduation.",
    art: <EscrowArt />,
  },
  {
    title: "A maker commits",
    body: "A market maker accepts the terms and posts a bond. It can place the inventory only on the token's Meteora DLMM pair: bids at or below the reference price, asks at or above it.",
    art: <CommitArt />,
  },
  {
    title: "Anyone verifies",
    body: "Anyone can check the maker's committed liquidity at any moment. The measurement values each price bin, so trading against the position cannot fake a pass or force a fail.",
    art: <VerifyArt />,
  },
  {
    title: "Pay or slash",
    body: "Each compliant period pays the maker from the fee budget. Consecutive failures slash the bond and end the mandate. At the end of the term, inventory returns to the issuer.",
    art: <SettleArt />,
  },
];

const AUDIENCES = [
  {
    icon: <Rocket />,
    title: "Launchpads",
    lede: "Every token you launch graduates with a market maker under contract.",
    points: [
      "Point your Meteora DBC config's leftover supply at a Mandate router",
      "Unsold supply becomes quoting inventory, never a dump",
      "A liquidity guarantee is a reason for creators to launch with you",
    ],
  },
  {
    icon: <Building2 />,
    title: "Token issuers",
    lede: "Stop lending tokens to market makers on trust.",
    points: [
      "Inventory can only be quoted, then comes back to you",
      "Pay per compliant period, not per promise",
      "Spread, depth and uptime are public for your holders to see",
    ],
  },
  {
    icon: <Activity />,
    title: "Market makers",
    lede: "Win mandates on a record nobody can dispute.",
    points: [
      "Every period you pass is written on-chain to your maker profile",
      "Terms, fees and slashing rules are code, not negotiation",
      "Scoring can't be gamed by traders or by the issuer",
    ],
  },
];

const GUARANTEES = [
  { icon: <Vault />, title: "Inventory has one exit", body: "Vault tokens move only into the mandate's own DLMM position and back. Settlement pays fixed recipients.", code: "instructions/liquidity.rs" },
  { icon: <Scale />, title: "Quotes are honest by construction", body: "The vault can only bid at or below the reference price and offer at or above it, inside the band the issuer sets.", code: "add_liquidity" },
  { icon: <Crosshair />, title: "A reference you can't nudge", body: "The reference follows the pair's time-weighted oracle price at a capped speed. A price pushed for one transaction moves nothing.", code: "anchor.rs" },
  { icon: <ShieldCheck />, title: "Scoring trades can't fake", body: "Checks value each bin at its own price, so buying out the book right before a snapshot changes nothing.", code: "scoring.rs" },
  { icon: <Eye />, title: "Anyone can check, any time", body: "Snapshots are permissionless and unlimited. The maker can't know when the next one comes, so it has to stay committed.", code: "snapshot" },
  { icon: <Lock />, title: "Skin in the game", body: "The maker's bond is slashed after the agreed number of failed periods in a row, and the mandate ends.", code: "finalize" },
];

export default function Landing() {
  return (
    <>
      <MarketingNav />
      <main>
        {/* Hero */}
        <section className="hero">
          <div className="container hero-grid">
            <div className="hero-copy">
              <Link href="/app" className="announce">
                <span className="tag pass">Live</span>
                A launched token is under contract on devnet right now
                <ArrowRight style={{ width: 14, height: 14, color: "var(--faint)" }} />
              </Link>
              <h1 className="display">Hire a market maker. The chain holds them to&nbsp;it.</h1>
              <p className="lead">
                Mandate turns a token&apos;s market-making agreement into a Solana program. The inventory can only be quoted on Meteora
                DLMM, anyone can check the quotes at any moment, and the maker is paid for every compliant hour or loses its bond.
              </p>
              <div className="hero-cta">
                <Link className="btn btn-primary btn-lg" href="/app">Open the app <ArrowRight /></Link>
                <a className="btn btn-secondary btn-lg" href="#how">See how it works</a>
              </div>
              <div className="hero-proof">
                <span><Layers />Built on Meteora DLMM and DBC</span>
                <span><ShieldCheck />37 tests against Meteora&apos;s mainnet programs</span>
                <span><GithubMarkSmall />Open source</span>
              </div>
            </div>
            <LiveContract />
          </div>
        </section>

        {/* Problem */}
        <section className="band-stripe">
          <div className="container section problem-grid">
            <div style={{ display: "grid", gap: 18 }}>
              <span className="kicker">The problem</span>
              <div className="stat-big">{Math.round(underCent * 100)}%</div>
              <h2 className="h2" style={{ maxWidth: "20ch" }}>of new Meteora pools can&apos;t absorb one cent without moving 2%.</h2>
              <p className="body-lg" style={{ maxWidth: "52ch" }}>
                We measured the {pools.toLocaleString("en-US")} newest DAMM v2 pools, where launchpad tokens graduate. Even among pools that
                traded over $10,000 in a day, the median could absorb ${s.volume24hAtLeast10k.medianDepth2pctUsd.toFixed(3)} before the price moved 2%.
                Volume arrives, trades once against the curve, and the book is empty again.
              </p>
              <Link className="link row" style={{ gap: 6 }} href="/research">Read the liquidity research <ArrowRight style={{ width: 15, height: 15 }} /></Link>
            </div>
            <div className="card card-pad" style={{ display: "grid", gap: 16 }}>
              <div className="row-between">
                <span className="h3">Two-sided depth within ±2%</span>
                <span className="xs muted">{pools.toLocaleString("en-US")} pools · Sep 2026</span>
              </div>
              <HBars buckets={hist} />
              <span className="xs muted">Depth computed from each pool&apos;s on-chain liquidity and price, not reported volume.</span>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="section">
          <div className="container">
            <div className="section-head">
              <span className="kicker">How it works</span>
              <h2 className="h2">A market-making agreement, executed by the program.</h2>
              <p className="body-lg">Four steps, all on-chain. Nobody has to trust the maker&apos;s dashboard or the issuer&apos;s word.</p>
            </div>
            <div className="steps">
              {STEPS.map((st, i) => (
                <div className="step" key={st.title}>
                  <div className="step-art">{st.art}</div>
                  <span className="step-n">0{i + 1}</span>
                  <h3 className="h3" style={{ fontSize: 17 }}>{st.title}</h3>
                  <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>{st.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Audiences */}
        <section id="who" className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-head">
              <span className="kicker">Who it&apos;s for</span>
              <h2 className="h2">One contract, three parties who finally agree on the facts.</h2>
            </div>
            <div className="audiences">
              {AUDIENCES.map((a) => (
                <div className="card audience" key={a.title}>
                  <span className="audience-icon">{a.icon}</span>
                  <div style={{ display: "grid", gap: 6 }}>
                    <h3 className="h3" style={{ fontSize: 18 }}>{a.title}</h3>
                    <p className="muted" style={{ margin: 0, fontSize: 15 }}>{a.lede}</p>
                  </div>
                  <ul>
                    {a.points.map((p) => <li key={p}><Check />{p}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Guarantees */}
        <section id="guarantees" className="section band-stripe">
          <div className="container">
            <div className="section-head">
              <span className="kicker">Enforced by the program</span>
              <h2 className="h2">Guarantees that hold even if someone is trying to cheat.</h2>
              <p className="body-lg">
                We attacked our own design before shipping it: forced failures, sandwiched snapshots, manipulated reference prices, and a
                quirk in DLMM&apos;s oracle. Every fix has a regression test.
              </p>
            </div>
            <div className="guarantees">
              {GUARANTEES.map((g) => (
                <div className="guarantee" key={g.title}>
                  {g.icon}
                  <h3 className="h3" style={{ fontSize: 16 }}>{g.title}</h3>
                  <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>{g.body}</p>
                  <code>{g.code}</code>
                </div>
              ))}
            </div>
            <div className="row wrap" style={{ marginTop: 20, gap: 12 }}>
              <a className="btn btn-secondary" href={SECURITY_URL} target="_blank" rel="noreferrer"><ShieldCheck />Read the security model</a>
              <span className="small muted">Self-reviewed and tested against Meteora&apos;s mainnet programs. Not yet externally audited.</span>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="section">
          <div className="container">
            <div className="cta-band">
              <div style={{ display: "grid", gap: 12 }}>
                <h2 className="h2">Put your token&apos;s liquidity under contract.</h2>
                <p style={{ margin: 0, opacity: 0.72, fontSize: 16, maxWidth: "50ch" }}>
                  Watch a live mandate, check a maker&apos;s record, or draft terms for your own token in a couple of minutes.
                </p>
              </div>
              <div className="row wrap">
                <Link className="btn btn-primary btn-lg" href="/app">Open the app <ArrowRight /></Link>
                <a className="btn btn-secondary btn-lg" href={REPO_URL} target="_blank" rel="noreferrer">View the source</a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function GithubMarkSmall() {
  return <span style={{ width: 15, height: 15, display: "inline-grid", color: "var(--faint)" }}><GithubMark /></span>;
}
