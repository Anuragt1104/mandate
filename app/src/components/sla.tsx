"use client";

import { useRef, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { CircleCheck, CircleDashed, OctagonX, TriangleAlert, Flag } from "lucide-react";
import type { Incident, Obligation, Rating, SlaStatus, Tick, Tone } from "@/lib/sla";
import { personaOf, type PersonaBook } from "@/lib/personas";
import { Address, Tip, duration, fmtFull, shortAddr } from "./ui";

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

export function IncidentList({ items, periodSecs, makerName, slashed, quote }: { items: Incident[]; periodSecs: number; makerName: string; slashed: string; quote: string }) {
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
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- contract

/** The terms, set as the schedules of an agreement. */
export function Schedule({ t, quote, decimals = 6, compact = false }: { t: any; quote: string; decimals?: number; compact?: boolean }) {
  const q = (v: any) => Number(v?.toString?.() ?? v) / 10 ** decimals;
  const minutes = (s: number) => duration(s);
  const clauses: { title: string; items: [string, ReactNode, string?][] }[] = [
    {
      title: "Schedule A · Service levels",
      items: [
        ["A.1", <><b>{fmtFull(q(t.minDepthQuote))} {quote}</b> of bids within {t.depthWindowBps / 100}% below the reference price</>],
        ["A.2", <><b>{fmtFull(q(t.minDepthQuote))} {quote}</b> of asks within {t.depthWindowBps / 100}% above it</>],
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
