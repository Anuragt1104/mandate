"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Menu } from "lucide-react";
import { CLUSTER } from "@/lib/chain";
import { Wordmark } from "./brand";
import { WalletButton } from "./wallet";

export function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export const REPO_URL = "https://github.com/Anuragt1104/mandate";
export const SECURITY_URL = `${REPO_URL}/blob/main/docs/security.md`;
export const PROGRAM_ID = "3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn";

/** The first customer's journey: see where you stand, the agreements, the reports. */
const APP_NAV = [
  { href: "/app", label: "Overview", match: (p: string) => p === "/app" },
  { href: "/app/agreements", label: "Agreements", match: (p: string) => p.startsWith("/app/agreements") || (p.startsWith("/app/mandate") && !p.endsWith("/report")) || p.startsWith("/app/create") },
  { href: "/app/reports", label: "Reports", match: (p: string) => ["/app/reports", "/app/report", "/app/monitor", "/app/draft"].some((x) => p.startsWith(x)) || p.endsWith("/report") },
];
/** Everything else, one step back. */
const MORE_NAV = [
  { href: "/app/operator", label: "Operator queue" },
  { href: "/app/makers", label: "Operator ratings" },
  { href: "/app/launch", label: "Launchpads" },
  { href: "/research", label: "Research" },
];

export function ClusterBadge() {
  if (CLUSTER === "mainnet") return null;
  return (
    <span className="cluster-badge hide-sm" title={`Reading Solana ${CLUSTER}`}>
      <span className="live-dot" />
      {CLUSTER}
    </span>
  );
}

export function AppNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Link href="/" aria-label="Mandate home"><Wordmark /></Link>
        <nav className={`nav ${open ? "open" : ""}`} aria-label="App" onClick={() => setOpen(false)}>
          {APP_NAV.map((n) => {
            const current = n.match ? n.match(path) : path.startsWith(n.href);
            return <Link key={n.href} href={n.href} aria-current={current ? "page" : undefined}>{n.label}</Link>;
          })}
          <span className="nav-sep" aria-hidden="true" />
          {MORE_NAV.map((n) => (
            <Link key={n.href} href={n.href} className="nav-secondary" aria-current={path.startsWith(n.href) ? "page" : undefined}>{n.label}</Link>
          ))}
        </nav>
        <div className="topbar-right">
          <ClusterBadge />
          <WalletButton size="sm" />
          <button className="icon-btn menu-toggle" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open} style={{ width: 32, height: 32 }}>
            <Menu />
          </button>
        </div>
      </div>
    </header>
  );
}

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Link href="/" aria-label="Mandate home"><Wordmark /></Link>
        <nav className={`nav ${open ? "open" : ""}`} aria-label="Main" onClick={() => setOpen(false)}>
          <a href="/#product">Product</a>
          <a href="/#operators">For operators</a>
          <a href="/#security">Security</a>
          <Link href="/app/agreements">Demo</Link>
        </nav>
        <div className="topbar-right">
          <a className="btn btn-ghost btn-sm hide-sm" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source on GitHub">
            <GithubMark />
            Source
          </a>
          <Link className="btn btn-primary btn-sm" href="/app/monitor">
            Start monitoring
            <ArrowRight />
          </Link>
          <button className="icon-btn menu-toggle" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open} style={{ width: 32, height: 32 }}>
            <Menu />
          </button>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-grid">
        <div style={{ display: "grid", gap: 10, maxWidth: 380 }}>
          <Wordmark size={22} />
          <span className="small muted">Liquidity SLAs for token markets, enforced on Solana. Quotes live on Meteora DLMM pairs; the agreement, the checks and the money live in the Mandate program.</span>
          <span className="mono xs faint">Program {PROGRAM_ID.slice(0, 6)}…{PROGRAM_ID.slice(-6)} · Solana {CLUSTER}</span>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link href="/app">Overview</Link>
          <Link href="/app/monitor">Monitor an arrangement</Link>
          <Link href="/app/draft">Draft with your operator</Link>
          <Link href="/app/agreements">Agreements</Link>
          <Link href="/app/makers">Operator ratings</Link>
          <Link href="/app/launch">For launchpads</Link>
          <Link href="/research">Research</Link>
          <a href={SECURITY_URL} target="_blank" rel="noreferrer">Security model</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
          <a href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noreferrer">Program on Explorer</a>
        </nav>
      </div>
    </footer>
  );
}
