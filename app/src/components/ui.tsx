"use client";

import { useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { Check, Copy, ExternalLink, Info, Minus, X } from "lucide-react";
import { explorerAddress, type TokenLabel } from "@/lib/chain";

// ---------------------------------------------------------------- formatting

export function fmt(n: number, digits = 2) {
  if (!isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtFull(n: number, digits = 2) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtPrice(p: number) {
  if (!p || !isFinite(p)) return "—";
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const digits = Math.min(12, Math.max(4, -Math.floor(Math.log10(p)) + 3));
  return p.toFixed(digits);
}

export function duration(secs: number) {
  secs = Math.max(0, Math.round(secs));
  if (secs % 60 === 0 && secs < 5400) return `${secs / 60} min`;
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)} min`;
  if (secs < 172800) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} days`;
}

export function countdown(secs: number) {
  secs = Math.max(0, Math.round(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function ago(secs: number) {
  if (secs < 5) return "just now";
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

export const shortAddr = (k: PublicKey | string, n = 4) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, n)}…${s.slice(-n)}`;
};

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- status

export type { StatusName } from "@/lib/sla";
import type { StatusName } from "@/lib/sla";

export const STATUS_META: Record<StatusName, { label: string; tone: "up" | "warn" | "down" | "open" | "ended"; hint: string }> = {
  Open: { label: "Open", tone: "open", hint: "Funded by the issuer and waiting for a market maker to accept." },
  Active: { label: "Live", tone: "up", hint: "A maker has posted its bond and is being scored every period." },
  Breached: { label: "Breached", tone: "down", hint: "The maker failed too many periods in a row and was slashed." },
  Expired: { label: "Term complete", tone: "ended", hint: "The term ran to the end. Funds can be unwound and settled." },
  Settled: { label: "Settled", tone: "ended", hint: "All funds have been distributed." },
  Cancelled: { label: "Cancelled", tone: "ended", hint: "The issuer cancelled before a maker accepted." },
};

export function StatusPill({ status }: { status: StatusName }) {
  const meta = STATUS_META[status] ?? STATUS_META.Open;
  return <span className={`chip ${meta.tone}`}><span className="dot" />{meta.label}</span>;
}

export function StatusIcon({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="status-icon none"><Minus /></span>;
  return <span className={`status-icon ${pass ? "pass" : "fail"}`}>{pass ? <Check /> : <X />}</span>;
}

// ---------------------------------------------------------------- tooltips

export function Tip({ content, children, className = "" }: { content: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={`tip ${className}`}>
      {children}
      <span className="tip-body" role="tooltip">{content}</span>
    </span>
  );
}

export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tip content={children}>
      <span className="info-dot" tabIndex={0} aria-label="More information"><Info /></span>
    </Tip>
  );
}

// ---------------------------------------------------------------- glyphs

/** Deterministic 5×5 symmetric identicon for a wallet or account. */
export function Identicon({ address, size = 22 }: { address: PublicKey | string; size?: number }) {
  const s = typeof address === "string" ? address : address.toBase58();
  const h = hash(s);
  const hue = h % 360;
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) cells.push(((h >>> i) & 1) === 1 || (hash(s + i) & 3) === 0);
  const fg = `hsl(${hue} 62% 48%)`;
  const bg = `hsl(${hue} 60% 94%)`;
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 5 5" aria-hidden="true" style={{ background: bg }}>
      {cells.map((on, i) => {
        if (!on) return null;
        const x = Math.floor(i / 5);
        const y = i % 5;
        return (
          <g key={i} fill={fg}>
            <rect x={x} y={y} width="1" height="1" />
            <rect x={4 - x} y={y} width="1" height="1" />
          </g>
        );
      })}
    </svg>
  );
}

export function TokenGlyph({ mint, label, size = 26 }: { mint: PublicKey | string; label?: TokenLabel; size?: number }) {
  const s = typeof mint === "string" ? mint : mint.toBase58();
  const symbol = label?.symbol ?? s.slice(0, 2);
  const known: Record<string, string> = { USDC: "#2775ca", SOL: "#6a4fe0" };
  const hue = hash(s) % 360;
  const bg = known[symbol] ?? `hsl(${hue} 38% 38%)`;
  return (
    <span className="token-glyph" style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {symbol.slice(0, symbol.length > 3 ? 1 : 2).toUpperCase()}
    </span>
  );
}

export function TokenPair({
  base,
  quote,
  labels,
  size = 28,
  sub,
}: {
  base: PublicKey;
  quote: PublicKey;
  labels?: Record<string, TokenLabel>;
  size?: number;
  sub?: ReactNode;
}) {
  const b = labels?.[base.toBase58()];
  const q = labels?.[quote.toBase58()];
  return (
    <span className="pair">
      <span className="pair-glyphs">
        <TokenGlyph mint={base} label={b} size={size} />
        <TokenGlyph mint={quote} label={q} size={size} />
      </span>
      <span style={{ display: "grid", minWidth: 0 }}>
        <span className="pair-name">
          {b?.symbol ?? shortAddr(base, 3)}
          <span className="sep">/</span>
          {q?.symbol ?? shortAddr(quote, 3)}
        </span>
        {sub && <span className="xs muted">{sub}</span>}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- addresses

export function Address({
  value,
  chars = 4,
  copy = true,
  explorer = true,
  glyph = false,
}: {
  value: PublicKey | string;
  chars?: number;
  copy?: boolean;
  explorer?: boolean;
  glyph?: boolean;
}) {
  const s = typeof value === "string" ? value : value.toBase58();
  const [copied, setCopied] = useState(false);
  async function doCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(s);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <span className="addr">
      {glyph && <Identicon address={s} size={16} />}
      <span title={s}>{shortAddr(s, chars)}</span>
      {copy && (
        <button className="icon-btn" onClick={doCopy} aria-label={copied ? "Copied" : "Copy address"} title={copied ? "Copied" : "Copy address"}>
          {copied ? <Check /> : <Copy />}
        </button>
      )}
      {explorer && (
        <a className="icon-btn" href={explorerAddress(s)} target="_blank" rel="noreferrer" aria-label="Open in Solana Explorer" title="Open in Solana Explorer" onClick={(e) => e.stopPropagation()}>
          <ExternalLink />
        </a>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- misc

export function Skeleton({ w = "100%", h = 14, style }: { w?: number | string; h?: number | string; style?: React.CSSProperties }) {
  return <span className="skeleton" style={{ display: "block", width: w, height: h, ...style }} />;
}

export function Kpi({ label, value, sub, info }: { label: string; value: ReactNode; sub?: ReactNode; info?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}{info && <InfoTip>{info}</InfoTip>}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
