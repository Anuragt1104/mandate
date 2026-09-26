"use client";

import { useRef, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { CircleCheck, CircleDashed, OctagonX, TriangleAlert, Flag, Radar } from "lucide-react";
import type { Incident, Obligation, Rating, SlaStatus, Tick, Tone } from "@/lib/sla";
import { DIAGNOSIS_LABELS, type Diagnosis } from "../../../sdk/src/sentinel";
import type { ShownRead } from "@/lib/trust";
import { executable, type Fill } from "../../../sdk/src/measure";
import { personaOf, type PersonaBook } from "@/lib/personas";
import { Address, InfoTip, Tip, ago, duration, fmtFull, shortAddr } from "./ui";

// ---------------------------------------------------------------- status

export function StatusChip({ tone, word }: { tone: Tone; word: string }) {
  return (
    <span className={`chip ${tone}`}>
      <span className="dot" />
      {word}
    </span>
  );
}

const BANNER_ICON: Record<Tone, ReactNode> = {
  up: <CircleCheck />,
  warn: <TriangleAlert />,
  down: <OctagonX />,
  open: <CircleDashed />,
  ended: <Flag />,
};

export function SlaBanner({ s, stat }: { s: SlaStatus; stat?: { value: string; label: string } }) {
  return (
    <div className={`banner ${s.tone}`} role="status">
      <span className="banner-icon">{BANNER_ICON[s.tone]}</span>
      <div style={{ minWidth: 0 }}>
        <h2>{s.headline}</h2>
        <p>{s.detail}</p>
      </div>
      {stat && (
        <div className="banner-stat">
          <span className="v">{stat.value}</span>
          <span className="xs muted">{stat.label}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- ticks

/** One mark per scored period. Hovering shows what that period recorded. */
export function Ticks({ ticks, size = "md", label }: { ticks: Tick[]; size?: "sm" | "md" | "lg"; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const interactive = size !== "sm";
  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const i = Math.min(ticks.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * ticks.length)));
    setHover(ticks[i]?.label ? { i, x: e.clientX - r.left } : null);
  };
  const up = ticks.filter((t) => t.kind === "up").length;
  const down = ticks.filter((t) => t.kind === "down").length;
  const idle = ticks.filter((t) => t.kind === "idle").length;
  const h = hover ? ticks[hover.i] : null;
  return (
    <div className="ticks-wrap" style={{ position: "relative", minWidth: 0 }}>
      <div ref={ref} className={`ticks ${size}`} role="img" aria-label={`${label ? `${label}: ` : ""}${up} met, ${down} missed, ${idle} not checked`}
        onMouseMove={interactive ? onMove : undefined} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <span key={i} className={`tick ${t.kind === "live-bad" ? "live bad" : t.kind}`} data-tip={hover?.i === i ? "" : undefined} />
        ))}
      </div>
      {h && hover && (
        <div className="hovercard" style={{ left: Math.min(Math.max(hover.x, 90), (ref.current?.clientWidth ?? 200) - 90), top: 0 }}>
          <b>{h.label}</b>
          {h.lines.map((l) => <div key={l} className="hc-dim">{l}</div>)}
        </div>
      )}
    </div>
  );
}

export function TickLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--up)" }} />Met</span>
      <span><i style={{ background: "var(--down)" }} />Missed</span>
      <span><i style={{ background: "var(--idle)" }} />Not checked</span>
      <span><i style={{ background: "repeating-linear-gradient(180deg, var(--up) 0 2px, transparent 2px 4px)", boxShadow: "inset 0 0 0 1px var(--up)" }} />In progress</span>
    </div>
  );
}

// ---------------------------------------------------------------- obligations

export function ObligationRows({ rows }: { rows: Obligation[] }) {
  return (
    <div>
      {rows.map((o) => {
        const r = o.observed ? o.met / o.observed : null;
        return (
          <div className="obligation" key={o.key}>
            <div className="name">
              <b>{o.name}</b>
              <span className="xs muted">{o.target}</span>
            </div>
            <Ticks ticks={o.ticks} label={o.name} />
            <span className="pct" style={{ color: r !== null && r < 0.95 ? "var(--down)" : undefined }}>{r === null ? "—" : `${(r * 100).toFixed(r === 1 ? 0 : 1)}%`}</span>
            <div className="now">
              <b style={{ color: o.now.pass === false ? "var(--down)" : undefined }}>{o.now.text}</b>
              <span className="xs faint">at the last check</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- incidents

export function IncidentList({ items, periodSecs, makerName, slashed, quote, causes = {} }: { items: Incident[]; periodSecs: number; makerName: string; slashed: string; quote: string; causes?: Record<number, string> }) {
  if (!items.length) {
    return (
      <div className="empty-state" style={{ padding: "28px 18px" }}>
        <CircleCheck style={{ color: "var(--up)" }} />
        <span className="small">No incidents. Every checked period met the agreement.</span>
      </div>
    );
  }
  const what = (w: string[]) => w.map((x) => (x === "empty side" ? "a side of the book empty" : x === "spread" ? "spread too wide" : `${x} below the minimum`)).join(", ");
  return (
    <div className="inc-list">
      {items.map((i) => (
        <div className={`inc ${i.ongoing || i.breach ? "" : "resolved"}`} key={i.from}>
          <span className="bar" />
          <div>
            <h4>
              {i.breach ? `Breach: ${makerName} slashed ${slashed} ${quote}` : i.ongoing ? "Ongoing: failing checks" : `Missed ${i.count} period${i.count === 1 ? "" : "s"}, then recovered`}
            </h4>
            <p>
              Periods {i.from + 1}{i.to !== i.from ? `–${i.to + 1}` : ""} · {duration(i.count * periodSecs)} · {what(i.what) || "an obligation missed"}
              {i.startTs ? ` · from ${new Date(i.startTs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </p>
            {causes[i.from] && <p style={{ marginTop: 3 }}>Watchtower read: <b style={{ color: "var(--ink-2)" }}>{causes[i.from]}</b></p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- contract

/** The terms, set as the schedules of an agreement. */
export function Schedule({ t, quote, decimals, compact = false }: { t: any; quote: string; decimals: number; compact?: boolean }) {
  const q = (v: any) => Number(v?.toString?.() ?? v) / 10 ** decimals;
  const minutes = (s: number) => duration(s);
  const clauses: { title: string; items: [string, ReactNode, string?][] }[] = [
    {
      title: "Schedule A · Service levels",
      items: [
        ["A.1", <><b>{fmtFull(q(t.minDepthQuote))} {quote}</b> of bids in the price bins within {t.depthWindowBps / 100}% below the reference price</>],
        ["A.2", <><b>{fmtFull(q(t.minDepthQuote))} {quote}</b> of asks in the bins within {t.depthWindowBps / 100}% above it</>],
        ["A.3", <>Spread no wider than <b>{t.maxSpreadBps} bps</b>, quoted at a size of {fmtFull(q(t.minDepthQuote) / 10)} {quote}</>],
        ["A.4", <>Quotes stay within <b>±{t.bandBps / 100}%</b>: bids at or below the reference, asks at or above it</>, compact ? undefined : `The reference follows the pair's ${minutes(t.anchorTwapSecs)} TWAP at up to ${t.anchorSpeedBpsPerMin / 100}% a minute.`],
      ],
    },
    {
      title: "Schedule B · Fees and term",
      items: [
        ["B.1", <><b>{fmtFull(q(t.feePerPeriod))} {quote}</b> for each compliant period, paid from escrow</>],
        ["B.2", <>Periods of <b>{minutes(t.periodSecs)}</b>, over a term of {t.durationPeriods.toLocaleString("en-US")} periods ({duration(t.periodSecs * t.durationPeriods)})</>],
      ],
    },
    {
      title: "Schedule C · Remedies",
      items: [
        ["C.1", <>A period with any failed check pays nothing</>],
        ["C.2", <><b>{t.maxConsecutiveFailures}</b> failed periods in a row slash <b>{t.slashBps / 100}%</b> of the {fmtFull(q(t.bondAmount))} {quote} bond and end the agreement</>],
        ["C.3", <>Inventory can only be quoted on the pair and returns to the issuer at the end</>, compact ? undefined : `Liquidity is locked for ${t.liquidityLockSecs} s after each deposit, so it can't be added for a check and pulled after.`],
      ],
    },
  ];
  return (
    <div style={{ display: "grid", gap: compact ? 18 : 22 }}>
      {clauses.map((c) => (
        <div className="schedule" key={c.title}>
          <div className="schedule-title">{c.title}</div>
          {c.items.map(([num, text, sub]) => (
            <div className="clause" key={num}>
              <span className="clause-n">{num}</span>
              <span className="clause-text" style={compact ? { fontSize: 13.5 } : undefined}>{text}{sub && <span className="sub">{sub}</span>}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- ratings

export function Grade({ r, large = false }: { r: Rating; large?: boolean }) {
  return (
    <Tip content={<span><b>{r.grade === "NR" ? "Not rated" : `Rated ${r.grade}`}</b><br />{r.why}</span>}>
      <span className={`grade ${r.cls} ${large ? "lg" : ""}`} tabIndex={0}>{r.grade}</span>
    </Tip>
  );
}

// ---------------------------------------------------------------- parties

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const ROLE_BG: Record<string, string> = {
  launchpad: "var(--ink)", issuer: "var(--ink-2)", maker: "var(--ink)", trader: "var(--muted)",
  whale: "var(--muted)", attacker: "var(--down)", watchtower: "var(--up)",
};

export function SimMark({ note }: { note?: string }) {
  return (
    <Tip content={note || "Simulated participant on the Mandate test network. Fictional name; real transactions."}>
      <span className="sim" tabIndex={0}>SIM</span>
    </Tip>
  );
}

/** A wallet by its persona name when it has one (marked as simulated), else its address. */
export function Party({ address, book, link = true, fallback }: { address: PublicKey | string; book: PersonaBook; link?: boolean; fallback?: ReactNode }) {
  const p = personaOf(book, address);
  if (!p) return fallback ? <>{fallback}</> : link ? <Address value={address} glyph /> : <span className="addr">{shortAddr(address)}</span>;
  return (
    <span className="party" title={typeof address === "string" ? address : address.toBase58()}>
      <span className="persona-mark" style={{ background: ROLE_BG[p.role] ?? "var(--ink)" }}>{initials(p.name)}</span>
      <span className="party-name">{p.name}</span>
      <SimMark note={`${p.bio} Simulated participant: fictional name, real transactions.`} />
    </span>
  );
}

/** Just the name, for sentences. */
export function nameOf(book: PersonaBook, address: PublicKey | string | null | undefined, fallback = "A wallet") {
  if (!address) return fallback;
  return personaOf(book, address)?.name ?? shortAddr(address);
}

// ---------------------------------------------------------------- sentinel

export const DIAGNOSIS_TONE: Record<Diagnosis, Tone> = {
  quoting_normally: "up",
  thin_but_compliant: "warn",
  withdrew_liquidity: "down",
  reference_moved: "warn",
  out_of_range: "down",
  not_started: "open",
  unclear: "ended",
};

/** "jev-1.13.0+rules" → "Jev 1.13 with rules"; "rules" → "Rules only". */
export function judgeName(source: string) {
  if (source === "rules") return "Rules only";
  const m = source.match(/^jev-(\d+\.\d+)/);
  const model = m ? `Jev ${m[1]}` : source.replace(/\+rules$/, "");
  return source.endsWith("+rules") ? `${model} with rules` : model;
}

function Gauge({ label, value, info }: { label: string; value: number; info: string }) {
  const tone = value >= 0.6 ? "var(--down)" : value >= 0.3 ? "var(--warn)" : "var(--up)";
  return (
    <div className="check">
      <span className="check-name" style={{ fontWeight: 560 }}>{label}<InfoTip>{info}</InfoTip></span>
      <span className="check-value" style={{ color: tone }}>{isFinite(value) ? `${Math.round(value * 100)}%` : "—"}</span>
      <span className="meter" aria-hidden="true"><span style={{ width: `${Math.max(2, (isFinite(value) ? value : 0) * 100)}%`, background: tone }} /></span>
    </div>
  );
}

/** The watchtower's latest advisory read of an SLA, from the memo on its check. */
export function SentinelCard({ shown, now }: { shown: ShownRead | null; now: number }) {
  const r = shown?.v.read;
  const trusted = shown?.standing === "trusted";
  const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3 row" style={{ gap: 8 }}><Radar style={{ width: 16, height: 16, color: "var(--muted)" }} />Watchtower outlook</span>
        {r && <span className="xs muted">{trusted ? `${shown!.publisherName} · ${judgeName(r.source)}` : "Unverified publisher"}</span>}
      </div>
      <div className="card-body" style={{ display: "grid", gap: 14 }}>
        {!r ? (
          <span className="small muted">No current read of this SLA. Watchtowers publish reads as signed memos on their checks; a read expires once it is out of date.</span>
        ) : (
          <>
            <div className="row-between wrap" style={{ gap: 8 }}>
              <StatusChip tone={DIAGNOSIS_TONE[r.diagnosis]} word={DIAGNOSIS_LABELS[r.diagnosis]} />
              {isFinite(r.confidence) && <span className="xs muted">confidence {Math.round(r.confidence * 100)}%</span>}
            </div>
            {!trusted && (
              <div className="notice warn xs">
                Published by <Address value={shown!.v.publisher} />, which this site doesn&apos;t list as a watchtower. Anyone can attach a read to a check, so treat this as third-party commentary; its claimed source is not shown.
              </div>
            )}
            {trusted && (
              <div className="checks">
                {isFinite(r.breach) && r.source !== "rules" && (
                  <Gauge label="Breach outlook" value={r.breach} info="How likely the agreement is to reach its limit of failed periods in a row, judged by a System One decision model from the checks, the maker's verified actions and its service history." />
                )}
                {isFinite(r.noRedeploy) && r.source !== "rules" && (
                  <Gauge label="No liquidity placed within two periods" value={r.noRedeploy} info="Asked only while the obligations are unmet: how likely it is that the maker places no liquidity that restores them over the next two scoring periods. Not asked when the maker's event history is incomplete." />
                )}
                <Gauge label="Next check failing" value={r.risk} info="Estimated by the watchtower's rules. It sets how often this SLA is checked: still at random, but more often when failure is likely." />
              </div>
            )}
            <span className="xs muted">
              Read of the check at {clock(r.observedTs)}, assessed {ago(Math.max(0, now - r.assessedAt))}; current until {clock(r.expiresAt)}.
            </span>
          </>
        )}
      </div>
      <div className="card-foot">
        <span className="xs muted">Advisory. The program pays and slashes from its own measurements; a read steers where watchtowers look and explains what they see. A listed publisher&apos;s signature proves who published it, not that a model produced it.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- committed vs executable

export function ExecutionPanel({ bins, activeBin, refUi, quote, committedOk, speedPctPerMin, sizes }: {
  bins: { binId: number; base: number; quote: number; priceUi: number }[];
  activeBin: number;
  refUi: number;
  quote: string;
  committedOk: boolean | null;
  speedPctPerMin: number;
  sizes: number[];
}) {
  const book = bins.map((b) => ({ binId: b.binId, base: b.base, quote: b.quote, price: b.priceUi }));
  const rows = sizes.map((s) => ({ s, ...executable(book, activeBin, refUi, s) }));
  const cell = (f: Fill) =>
    f.cost === null ? <span className="faint">no liquidity</span>
      : <span style={{ color: f.filled < 0.999 ? "var(--down)" : f.cost > 0.05 ? "var(--warn)" : undefined }}>{(f.cost * 100).toFixed(2)}%{f.filled < 0.999 ? ` · ${Math.round(f.filled * 100)}% filled` : ""}</span>;
  const mid = rows[Math.min(1, rows.length - 1)];
  const poor = !!committedOk && (mid.buy.cost === null || mid.sell.cost === null || mid.buy.filled < 0.999 || mid.sell.filled < 0.999 || (mid.buy.cost ?? 0) > 0.05 || (mid.sell.cost ?? 0) > 0.05);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="table-wrap">
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th>Trade size</th><th className="r">Buy costs</th><th className="r">Sell costs</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.s}><td className="num">{r.s.toLocaleString("en-US")} {quote}</td><td className="r num">{cell(r.buy)}</td><td className="r num">{cell(r.sell)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {poor ? (
        <div className="notice warn">
          <TriangleAlert />
          <span>
            The agreement is met, but trading is poor right now. The agreement measures where the maker committed liquidity, not what is left after trades.
            When traders drain a side, the maker has to re-quote it before the reference price (moving up to {speedPctPerMin}% a minute) catches up; after that the side counts as missing.
          </span>
        </div>
      ) : (
        <span className="xs muted">
          Execution against the maker&apos;s current book only, before swap fees; other liquidity on the pair makes it cheaper. It is shown, not enforced: the agreement measures committed liquidity, which trades can&apos;t fake.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the agreement in plain words

export interface AgreementFacts {
  base: string;
  quote: string;
  baseDeposit: number | null;
  quoteDeposit: number | null;
  feeBudget: number | null;
  bond: number;
  feePerPeriod: number;
  periodSecs: number;
  periods: number;
  minDepth: number;
  windowPct: number;
  maxSpreadBps: number;
  bandPct: number;
  speedPctPerMin: number;
  maxFailures: number;
  slashPct: number;
  lockSecs: number;
  maker: string | null; // the maker's name/address, or null when anyone may accept
  designated?: boolean;
  endsAt?: number | null; // unix seconds, when known
  /** Plain sentences about mint powers that could hurt the inventory (freeze, unlimited minting). */
  tokenRisks?: string[];
}

/** Every term, as a sentence both parties can check before signing. */
export function AgreementSummary({ f, audience = "both" }: { f: AgreementFacts; audience?: "team" | "maker" | "both" }) {
  const n = (x: number, d = 2) => fmtFull(x, d);
  const term = duration(f.periodSecs * f.periods);
  const maxPay = f.feePerPeriod * f.periods;
  const returnPct = f.bond > 0 ? (maxPay / f.bond) * 100 : null;
  const yearly = returnPct !== null ? returnPct * (365 * 86_400) / (f.periodSecs * f.periods) : null;
  const budgetShort = f.feeBudget !== null && f.feeBudget < maxPay;
  const items: [string, ReactNode][] = [
    ["The team puts in", <>
      {f.baseDeposit !== null || f.quoteDeposit !== null ? <><b>{n(f.baseDeposit ?? 0, 0)} {f.base}</b> and <b>{n(f.quoteDeposit ?? 0)} {f.quote}</b> of inventory</> : "Inventory"} in a vault the maker can only quote from, and {f.feeBudget !== null ? <><b>{n(f.feeBudget)} {f.quote}</b></> : "a fee budget"} to pay for compliant periods.
      {" "}Every fee the maker could earn must be in the vault before a maker can accept.
      {budgetShort && <> <span style={{ color: "var(--warn)" }}>This budget covers {Math.floor((f.feeBudget ?? 0) / Math.max(f.feePerPeriod, 1e-9)).toLocaleString("en-US")} of {f.periods.toLocaleString("en-US")} periods, so no maker can accept it until it is topped up to {n(maxPay)} {f.quote}.</span></>}
      {" "}Inventory needs both sides: {f.base} for asks and {f.quote} for bids. Leftover launch supply only covers the first.
    </>],
    ["The maker commits", <>
      {f.maker ? <>{f.maker}{f.designated ? " (designated)" : ""}</> : "Any maker who accepts"} posts a <b>{n(f.bond)} {f.quote}</b> bond and keeps at least <b>{n(f.minDepth)} {f.quote}</b> of bids in the price bins within {f.windowPct}% below the reference price and the same of asks in the bins within {f.windowPct}% above it, with a spread no wider than {f.maxSpreadBps} bps. Quotes must stay within ±{f.bandPct}%, and each deposit is locked for {f.lockSecs} s.
    </>],
    ["What earns pay", <>Scoring starts one minute after the maker accepts (time to place quotes). Each {duration(f.periodSecs)} period that is checked at least once, with every check passing, pays <b>{n(f.feePerPeriod)} {f.quote}</b>, up to <b>{n(maxPay)} {f.quote}</b> over {term}.</>],
    ["What counts as a miss", <>A check finds committed bids or asks below the minimum, or the spread too wide. Trades against the book don&apos;t change that measure; the maker&apos;s own withdrawals and moves of the reference price do. A period with any failed check pays nothing. The reference follows the market at up to {f.speedPctPerMin}% a minute, so a maker who doesn&apos;t re-centre after a move starts failing as it catches up; that speed is a limit, not a guaranteed grace period.</>],
    ["The penalty", <><b>{f.maxFailures}</b> failed periods with no passing period between them send <b>{f.slashPct}%</b> of the bond to the team and end the agreement. Periods nobody checks don&apos;t reset that count, and don&apos;t add to it. There is no exception for outages or extreme volatility: price that risk into the fee.</>],
    ["Who checks", <>Anyone can check, at any time, for a network fee of about 0.000005 SOL. Someone has to: a period nobody checks is neither paid nor failed. The team, the launchpad or a watchtower should run one, and agree who funds it.</>],
    ...(f.tokenRisks?.length ? [["Token risks", <>{f.tokenRisks.join(" ")} The bond covers missed service, not these.</>] as [string, ReactNode]] : []),
    ["How it ends", <>After {f.periods.toLocaleString("en-US")} periods{f.endsAt ? <> ({new Date(f.endsAt * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })})</> : null}, or at a breach. Neither side can leave early once a maker accepts; until then the team can cancel. At settlement the inventory and unused fees go back to the team and the maker gets its earned fees and remaining bond.</>],
  ];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.map(([k, v]) => (
        <div key={k} className="clause" style={{ gridTemplateColumns: "118px minmax(0, 1fr)" }}>
          <span className="eyebrow" style={{ paddingTop: 2 }}>{k}</span>
          <span className="small" style={{ color: "var(--ink-2)", lineHeight: 1.55 }}>{v}</span>
        </div>
      ))}
      {audience !== "team" && returnPct !== null && (
        <div className="notice" style={{ display: "grid", gap: 4 }}>
          <b style={{ color: "var(--ink)" }}>For the maker</b>
          <span>
            Capital locked: {n(f.bond)} {f.quote} bond for {term}, plus the operating cost of quoting. Most it can earn: {n(maxPay)} {f.quote}, {returnPct.toFixed(1)}% on the bond
            {yearly !== null && isFinite(yearly) ? ` (${yearly >= 1000 ? "over 1,000" : yearly.toFixed(0)}% a year)` : ""} if every period passes. The inventory&apos;s trading gains or losses stay in the vault and go back to the team.
          </span>
        </div>
      )}
    </div>
  );
}

/** What the mints allow that could hurt the escrowed inventory, in plain sentences. */
export function tokenRisks(base: { symbol: string; mintAuthority: string | null; freezeAuthority: string | null }, quote: { symbol: string; freezeAuthority: string | null }): string[] {
  const out: string[] = [];
  if (base.mintAuthority) out.push(`${base.symbol} can still be minted by its mint authority, which can dilute the inventory's value.`);
  if (quote.freezeAuthority) out.push(`${quote.symbol} has a freeze authority, which could freeze the vault's ${quote.symbol} (common for regulated stablecoins such as USDC).`);
  return out;
}
