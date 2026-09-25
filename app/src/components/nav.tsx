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

const APP_NAV = [
  { href: "/app", label: "Mandates", exact: true },
  { href: "/app/makers", label: "Makers" },
  { href: "/app/create", label: "New mandate" },
  { href: "/app/launch", label: "Launchpads" },
  { href: "/research", label: "Research" },
];

export function AppNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Link href="/" aria-label="Mandate home" className="row" style={{ gap: 8 }}>
          <Wordmark />
          <span className="brand-tag hide-sm">App</span>
        </Link>
        <nav className={`nav ${open ? "open" : ""}`} aria-label="App" onClick={() => setOpen(false)}>
          {APP_NAV.map((n) => {
            const current = n.exact ? path === n.href || path.startsWith("/app/mandate") : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={current ? "page" : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="topbar-right">
          {CLUSTER !== "mainnet" && (
            <span className="cluster-badge hide-sm" title={`Connected to Solana ${CLUSTER}`}>
              <span className="live-dot" />
              {CLUSTER === "devnet" ? "Devnet" : CLUSTER === "localnet" ? "Localnet" : CLUSTER}
            </span>
          )}
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
          <a href="/#how">How it works</a>
          <a href="/#who">Who it&apos;s for</a>
          <a href="/#guarantees">Guarantees</a>
          <Link href="/research">Research</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Docs</a>
        </nav>
        <div className="topbar-right">
          <a className="btn btn-ghost btn-sm hide-sm" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source on GitHub">
            <GithubMark />
            GitHub
          </a>
          <Link className="btn btn-primary btn-sm" href="/app">
            Open app
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
        <div style={{ display: "grid", gap: 12, maxWidth: 360 }}>
          <Wordmark size={22} />
          <span>Market-making contracts enforced on Solana. Built on Meteora DLMM and the Dynamic Bonding Curve.</span>
          <span className="mono xs faint">Program {PROGRAM_ID.slice(0, 6)}…{PROGRAM_ID.slice(-6)} · Solana {CLUSTER}</span>
        </div>
        <div className="footer-links">
          <div>
            <b>Product</b>
            <Link href="/app">Mandates</Link>
            <Link href="/app/makers">Maker records</Link>
            <Link href="/app/create">Create a mandate</Link>
            <Link href="/app/launch">For launchpads</Link>
          </div>
          <div>
            <b>Learn</b>
            <a href="/#how">How it works</a>
            <Link href="/research">Liquidity research</Link>
            <a href={SECURITY_URL} target="_blank" rel="noreferrer">Security model</a>
          </div>
          <div>
            <b>Build</b>
            <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">Run it locally</a>
            <a href={`https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noreferrer">Program on Explorer</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
