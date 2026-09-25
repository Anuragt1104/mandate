"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CLUSTER } from "@/lib/chain";

const WalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

const NAV = [
  { href: "/", label: "Mandates" },
  { href: "/makers", label: "Market makers" },
  { href: "/create", label: "New mandate" },
  { href: "/launch", label: "Launch" },
  { href: "/study", label: "Liquidity study" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="wordmark" aria-label="Mandate home">
          <span className="plaque">M</span>Mandate
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <span className="cluster" title="Cluster">{CLUSTER}</span>
        {CLUSTER !== "mainnet" && <TestSolButton />}
        <WalletMultiButton />
      </div>
    </header>
  );
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${status.toLowerCase()}`}>{status}</span>;
}

/** One cell per scoring period. `live` is the period currently being observed. */
export function Tape({
  entries,
  live,
  total,
  large = false,
}: {
  entries: { status: number }[];
  live?: { failed: boolean } | null;
  total?: number;
  large?: boolean;
}) {
  const cls = (s: number) => (s === 1 ? "ok" : s === 2 ? "failed" : s === 3 ? "unobserved" : "");
  const pending = total ? Math.max(0, Math.min(total - entries.length - (live ? 1 : 0), large ? 48 : 12)) : 0;
  const label = `${entries.filter((e) => e.status === 1).length} compliant, ${entries.filter((e) => e.status === 2).length} failed, ${entries.filter((e) => e.status === 3).length} unobserved periods`;
  return (
    <div className={`tape ${large ? "large" : ""}`} role="img" aria-label={label}>
      {entries.map((e, i) => (
        <span key={i} className={`cell ${cls(e.status)}`} />
      ))}
      {live && <span className={`cell live ${live.failed ? "bad" : ""}`} title="Current period" />}
      {Array.from({ length: pending }).map((_, i) => (
        <span key={`p${i}`} className="cell" />
      ))}
    </div>
  );
}

export function TapeLegend() {
  return (
    <div className="tape-legend">
      <span><i style={{ background: "var(--ok)" }} />Compliant</span>
      <span><i style={{ background: "var(--fail)" }} />Failed</span>
      <span><i style={{ background: "var(--idle)", opacity: 0.55 }} />Not observed</span>
      <span><i style={{ background: "repeating-linear-gradient(135deg, var(--ok) 0 3px, transparent 3px 6px)", border: "1px solid var(--ok)" }} />In progress</span>
    </div>
  );
}

export function fmt(n: number, digits = 2) {
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtPrice(p: number) {
  if (!p || !isFinite(p)) return "—";
  if (p >= 1) return p.toFixed(4);
  const digits = Math.min(12, Math.max(4, -Math.floor(Math.log10(p)) + 3));
  return p.toFixed(digits);
}

export function duration(secs: number) {
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)} min`;
  if (secs < 172800) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} days`;
}

/** Test-cluster convenience: airdrop SOL to the connected wallet. */
function TestSolButton() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  if (!publicKey) return null;
  async function airdrop() {
    setState("busy");
    try {
      const sig = await connection.requestAirdrop(publicKey!, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 6000);
  }
  return (
    <button className="btn ghost" onClick={airdrop} disabled={state === "busy"} title="Airdrop 2 SOL on this test cluster">
      {state === "busy" ? "Requesting…" : state === "done" ? "Received 2 SOL" : state === "failed" ? "Faucet busy: try faucet.solana.com" : "Get test SOL"}
    </button>
  );
}
