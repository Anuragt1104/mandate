"use client";

import type { ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { ArrowDownToLine, ArrowUpFromLine, CalendarClock, Coins, FilePen, Flag, Gavel, Handshake, PackageOpen, Scale, ScanSearch, Swords } from "lucide-react";
import type { FeedEvent } from "@/lib/feed";
import { personaOf, type PersonaBook } from "@/lib/personas";
import { explorerUrl } from "@/lib/chain";
import { Skeleton, ago, fmt, shortAddr } from "./ui";
import { SimMark } from "./sla";

export interface FeedContext {
  book: PersonaBook;
  /** mandate address → what the feed needs to name it */
  mandates: Record<string, { symbol: string; quote: string; maker: PublicKey; issuer: PublicKey; terms: any } | undefined>;
}

type Line = { icon: ReactNode; tone?: "up" | "down" | "warn" | "ink"; text: ReactNode; minor?: boolean };

const amt = (v: any, decimals = 6) => {
  const x = Number(v?.toString?.() ?? v) / 10 ** decimals;
  return fmt(x, x >= 100 ? 0 : 2);
};

function Who({ address, ctx }: { address: PublicKey | string | null | undefined; ctx: FeedContext }) {
  if (!address) return <b>Someone</b>;
  const p = personaOf(ctx.book, address);
  return p ? <><b>{p.name}</b> <SimMark note={`${p.bio} Simulated participant: fictional name, real transactions.`} /></> : <b className="mono" style={{ fontSize: 12 }}>{shortAddr(address)}</b>;
}

function describe(ev: FeedEvent, ctx: FeedContext): Line | null {
  const d = ev.data;
  const info = ctx.mandates[ev.mandate];
  const sym = info?.symbol ?? "token";
  const q = info?.quote ?? "USDC";
  const market = <b>{sym}/{q}</b>;
  switch (ev.name) {
    case "mandateCreated": {
      const t = d.terms;
      return {
        icon: <FilePen />, tone: "ink",
        text: <><Who address={d.issuer} ctx={ctx} /> posted a liquidity SLA for {market}: {amt(t.minDepthQuote)} {q} each side within ±{t.depthWindowBps / 100}%, spread ≤ {t.maxSpreadBps} bps, {amt(t.feePerPeriod)} {q} per compliant period.</>,
      };
    }
    case "leftoverRouted":
      return { icon: <PackageOpen />, text: <><Who address={ev.signer} ctx={ctx} /> routed {amt(d.amount)} {sym} of unsold launch supply into the {market} SLA&apos;s vault.</> };
    case "mandateAccepted":
      return { icon: <Handshake />, tone: "up", text: <><Who address={d.maker} ctx={ctx} /> accepted the {market} SLA{info ? <> and posted a {amt(info.terms.bondAmount)} {q} bond</> : null}.</> };
    case "liquidityDeployed": {
      const parts = [Number(d.amountQuote) > 0 ? `${amt(d.amountQuote)} ${q} of bids` : null, Number(d.amountBase) > 0 ? `${amt(d.amountBase)} ${sym} of asks` : null].filter(Boolean);
      return { icon: <ArrowDownToLine />, text: <><Who address={ev.signer} ctx={ctx} /> placed {parts.join(" and ")} on the {market} book.</>, minor: true };
    }
    case "liquidityWithdrawn": {
      const byMaker = info && info.maker.toBase58() === ev.signer;
      return byMaker
        ? { icon: <ArrowUpFromLine />, tone: "warn", text: <><Who address={ev.signer} ctx={ctx} /> pulled its {market} liquidity back into the vault.</> }
        : { icon: <ArrowUpFromLine />, text: <><Who address={ev.signer} ctx={ctx} /> unwound the {market} position after the agreement ended.</> };
    }
    case "snapshotTaken": {
      const ok = !!d.ok;
      const pushed = Math.abs(Number(d.activeId) - Number(d.anchorBin));
      const cranker = personaOf(ctx.book, d.cranker);
      const detail = `bids ${amt(d.bidDepthQuote)} · asks ${amt(d.askDepthQuote)} · spread ${d.spreadBps === 65535 ? "—" : `${d.spreadBps} bps`}`;
      if (cranker?.role === "attacker") {
        return {
          icon: <Swords />, tone: ok ? "up" : "down",
          text: <><Who address={d.cranker} ctx={ctx} /> pushed the {market} price {pushed} bin{pushed === 1 ? "" : "s"} and forced a check in the same transaction. <b style={{ color: ok ? "var(--up)" : "var(--down)" }}>{ok ? "The check still passed." : "The check failed."}</b></>,
        };
      }
      return {
        icon: <ScanSearch />, tone: ok ? "up" : "down", minor: ok,
        text: <><Who address={d.cranker} ctx={ctx} /> checked {market}: {ok ? "all obligations met" : <b style={{ color: "var(--down)" }}>obligations missed</b>} <span className="faint">· {detail}</span></>,
      };
    }
    case "periodFinalized": {
      const s = Number(d.status);
      if (s === 1) return { icon: <CalendarClock />, minor: true, text: <>{market} period {Number(d.period) + 1} closed compliant: {amt(d.feeAccrued)} {q} earned by <Who address={info?.maker} ctx={ctx} />.</> };
      if (s === 2) return { icon: <CalendarClock />, tone: "down", text: <>{market} period {Number(d.period) + 1} closed <b>failed</b>: no fee for <Who address={info?.maker} ctx={ctx} />.</> };
      return { icon: <CalendarClock />, minor: true, text: <>{market} period {Number(d.period) + 1} went unchecked: neither paid nor failed.</> };
    }
    case "makerSlashed":
      return { icon: <Gavel />, tone: "down", text: <><Who address={d.maker} ctx={ctx} /> was slashed <b>{amt(d.amount)} {q}</b> after {d.consecutiveFailed} failed periods in a row. The {market} SLA is breached.</> };
    case "mandateExpired":
      return { icon: <Flag />, text: <>The {market} SLA completed its term.</> };
    case "makerFeesClaimed":
      return { icon: <Coins />, tone: "up", text: <><Who address={d.maker} ctx={ctx} /> collected {amt(d.amount)} {q} in fees earned on {market}.</> };
    case "mandateSettled":
      return {
        icon: <Scale />,
        text: <>{market} SLA settled: {amt(d.toIssuerBase)} {sym} and {amt(d.toIssuerQuote)} {q} back to <Who address={info?.issuer} ctx={ctx} />, {amt(d.toMakerQuote)} {q} to <Who address={info?.maker} ctx={ctx} />.</>,
      };
    default:
      return null;
  }
}

export function ActivityFeed({ events, ctx, max = 40, showChecks = true, error }: { events: FeedEvent[] | null; ctx: FeedContext; max?: number; showChecks?: boolean; error?: string | null }) {
  if (!events) {
    return (
      <div className="feed" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="feed-item" key={i}><Skeleton w={22} h={22} /><div style={{ display: "grid", gap: 6 }}><Skeleton w="90%" h={12} /><Skeleton w="40%" h={10} /></div></div>
        ))}
        {error && <div className="notice subtle" style={{ margin: 12 }}>{error}</div>}
      </div>
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const lines = events
    .map((ev) => ({ ev, line: describe(ev, ctx) }))
    .filter((x): x is { ev: FeedEvent; line: Line } => !!x.line && (showChecks || !x.line.minor))
    .slice(0, max);
  if (!lines.length) return <div className="empty-state"><span className="small">No activity yet.</span></div>;
  return (
    <div className="feed" aria-live="polite">
      {lines.map(({ ev, line }) => (
        <div key={ev.key} className={`feed-item ${line.minor ? "minor" : ""}`}>
          <span className={`feed-icon ${line.tone ?? ""}`}>{line.icon}</span>
          <div style={{ minWidth: 0 }}>
            <div className="feed-text">{line.text}</div>
            <div className="feed-meta">
              <span>{ev.ts ? ago(Math.max(0, now - ev.ts)) : "pending"}</span>
              <span>·</span>
              <a href={explorerUrl(ev.sig)} target="_blank" rel="noreferrer">{ev.sig.slice(0, 8)}</a>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
