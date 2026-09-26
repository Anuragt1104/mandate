import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Footer, MarketingNav, SECURITY_URL } from "@/components/nav";
import { AgreeFragment, ObserveFragment, ProductPreview, RenewFragment } from "@/components/preview";


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

const FAQ: [string, string][] = [
  ["Does Mandate hold our tokens?", "No company holds them. Inventory sits in vaults owned by the agreement's program account. The operator can only place it as quotes on the agreed Meteora pool and withdraw it back to those vaults; at the end it returns to the team."],
  ["What is private and what is public?", "Drafts, negotiation and observation reports stay with you: in this version, in your browser and in links you choose to share. Anything that happens on chain, such as a funded agreement, its checks, payments and penalties, is public, like every Solana transaction."],
  ["Does passing the checks mean traders get good prices?", "Not necessarily. The agreement enforces committed liquidity near a reference price. What a trader can actually execute moves with every trade, so Mandate shows it next to the enforced measure and in every report, without making it the obligation."],
  ["Is monitoring a guarantee?", "No. Observation tells you what the operator delivered when it was checked. Periods nobody checks are neither paid nor failed, and reports say how much of the time was covered."],
  ["What happens if the operator stops?", "Checks fail, and after the agreed number of failed periods part of its bond goes to the team, the inventory is unwound and returned, and the closing report records the gap until the next operator starts."],
  ["Can we use it with real funds today?", "Not yet. The program runs on Solana devnet with simulated participants. Monitoring works on mainnet pools now; escrowed agreements on mainnet wait for an independent audit."],
];

export default function Landing() {
  return (
    <>
      <MarketingNav />
      <main>
        <section className="hero lp-hero">
          <div className="container lp-hero-grid">
            <div className="hero-copy">
              <span className="status-line"><span className="live-dot" />Accountable liquidity management · live on Solana devnet</span>
              <h1 className="display hero-title">Your liquidity agreements. Verified.</h1>
              <p className="lead">
                Monitor your operator, agree clear terms, and settle service payments with your inventory restricted to the agreed market.
              </p>
              <div className="hero-cta">
                <Link className="btn btn-primary btn-lg" href="/app/monitor">Monitor an arrangement <ArrowRight /></Link>
                <Link className="btn btn-secondary btn-lg" href="/app/agreements">Explore the demo</Link>
              </div>
              <a className="link small" href="#operators">Run liquidity for token teams? What operators get →</a>
            </div>
            <ProductPreview />
          </div>
        </section>

        <section id="product" className="section tight">
          <div className="container">
            <div className="section-head">
              <span className="kicker">How it works</span>
              <h2 className="h2">Observe, agree, then manage and renew.</h2>
            </div>
            <div className="flow">
              <div className="flow-step">
                <span className="flow-n">1 · Observe</span>
                <ObserveFragment />
                <p>Point Mandate at the pool your operator already manages. With no wallet and no deposit, you get a period-by-period record of what they actually delivered.</p>
              </div>
              <div className="flow-step">
                <span className="flow-n">2 · Agree</span>
                <AgreeFragment />
                <p>Draft terms from that record, see what each side commits, and negotiate by link. Both sides sign the exact same terms before anything is funded.</p>
              </div>
              <div className="flow-step">
                <span className="flow-n">3 · Manage and renew</span>
                <RenewFragment />
                <p>Payment follows the checks. At the end of the term, a report shows what the service was worth and proposes the next terms.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="operators" className="section tight" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="two-sides">
              <div className="side-card">
                <span className="kicker">For token teams</span>
                <h3>Keep your operator, lose the blind trust.</h3>
                <ul>
                  <li><Check />Inventory can only be quoted on your pool, and comes back</li>
                  <li><Check />Pay per verified period instead of settling an invoice by hand</li>
                  <li><Check />A report you can take to a renewal or a remediation conversation</li>
                </ul>
              </div>
              <div className="side-card">
                <span className="kicker">For operators</span>
                <h3>Explicit terms, funded fees, a record that travels.</h3>
                <ul>
                  <li><Check />Every fee is escrowed before you accept; payment is automatic</li>
                  <li><Check />Negotiate bond, tolerance and term before signing, version by version</li>
                  <li><Check />A work queue with what changed and a simulated next action</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-head">
              <span className="kicker">What is enforced</span>
              <h2 className="h2">Committed liquidity, measured the same way by everyone.</h2>
              <p className="body-lg">
                The program measures the operator&apos;s liquidity near a manipulation-resistant reference price, bin by bin, so trades against the book can&apos;t fake a pass or force a fail. What a trader can execute is shown next to it, not enforced.
              </p>
            </div>
            <div className="contract">
              <div className="contract-col">
                {ENFORCEMENT.map((e) => (
                  <div className="enforce" key={e.title}>
                    <h4>{e.title}</h4>
                    <p>{e.body}</p>
                  </div>
                ))}
                <a className="link small" href={SECURITY_URL} target="_blank" rel="noreferrer">Read the security model</a>
              </div>
              <div className="contract-col">
                <span className="h3">It holds up under attack</span>
                <span className="small muted">Simulated participants run these against the test network. The ordinary, paid-and-renewed agreement is the everyday case; these are the edges.</span>
                {INCIDENTS.map((i) => (
                  <details key={i.title} className="attack">
                    <summary><span>{i.title}</span><span className={`chip ${i.tone}`}><span className="dot" />{i.outcome}</span></summary>
                    <p><b>Attempt.</b> {i.attempt}</p>
                    <p><b>Why.</b> {i.why}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container narrow">
            <div className="section-head">
              <span className="kicker">Questions</span>
              <h2 className="h2">What it does, and what it doesn&apos;t.</h2>
            </div>
            <div className="faq">
              {FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="closing">
              <div style={{ display: "grid", gap: 12 }}>
                <h2 className="h2">Start with the arrangement you already have.</h2>
                <p>Monitoring needs no wallet and no deposit. See what your operator delivers, then decide what to agree.</p>
              </div>
              <div className="row wrap">
                <Link className="btn btn-primary btn-lg" href="/app/monitor">Start monitoring <ArrowRight /></Link>
                <Link className="btn btn-secondary btn-lg" href="/app/agreements">Explore the demo</Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
