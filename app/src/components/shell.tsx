"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, ClipboardList, Compass, FileText, LayoutDashboard, Menu, Radar, Rocket, Star, Wrench, X } from "lucide-react";
import { CLUSTER } from "@/lib/chain";
import { Wordmark } from "./brand";
import { WalletButton } from "./wallet";
import { ThemeToggle } from "./theme";
import { useAccount } from "./account";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Radar;
  match: (p: string) => boolean;
}

/** The team's journey: where things stand, the agreements, observation, and the reports that lead to renewals. */
const PRIMARY: NavItem[] = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, match: (p) => p === "/app" },
  { href: "/app/agreements", label: "Agreements", icon: ClipboardList, match: (p) => p.startsWith("/app/agreements") || (p.startsWith("/app/mandate") && !p.endsWith("/report")) || p.startsWith("/app/create") },
  { href: "/app/monitoring", label: "Monitoring", icon: Radar, match: (p) => p.startsWith("/app/monitoring") || p.startsWith("/app/monitor") },
  { href: "/app/reports", label: "Reports and drafts", icon: FileText, match: (p) => p.startsWith("/app/reports") || p.startsWith("/app/report") || p.startsWith("/app/draft") || p.endsWith("/report") },
];
const OPERATORS: NavItem[] = [{ href: "/app/operator", label: "Operator queue", icon: Wrench, match: (p) => p.startsWith("/app/operator") }];
const EXPLORE: NavItem[] = [
  { href: "/app/makers", label: "Operator records", icon: Star, match: (p) => p.startsWith("/app/makers") },
  { href: "/app/launch", label: "Launchpads", icon: Rocket, match: (p) => p.startsWith("/app/launch") },
  { href: "/research", label: "Research", icon: BookOpen, match: (p) => p.startsWith("/research") },
  { href: "/", label: "Product site", icon: Compass, match: () => false },
];

/** Workspace URLs (/app/w/<id>/monitoring) resolve to the pages they show, for highlighting. */
const plain = (p: string) => p.replace(/^\/app\/w\/[^/]+\/settings/, "/app/workspace").replace(/^\/app\/w\/[^/]+/, "/app");
/** The open workspace's own URL for a page that has one. */
const scoped = (href: string, ws: string | undefined) =>
  !ws ? href : href === "/app" ? `/app/w/${ws}` : ["/app/monitoring", "/app/reports"].includes(href) ? `/app/w/${ws}${href.slice(4)}` : href;

function Group({ title, items, path, ws }: { title?: string; items: NavItem[]; path: string; ws?: string }) {
  return (
    <div className="side-group">
      {title && <span className="side-title">{title}</span>}
      {items.map((n) => (
        <Link key={n.href} href={scoped(n.href, ws)} aria-current={n.match(plain(path)) ? "page" : undefined}>
          <n.icon aria-hidden="true" />
          {n.label}
        </Link>
      ))}
    </div>
  );
}

/** Where work is kept: the open workspace, or this browser when there's no account. */
function WorkspaceBlock() {
  const acct = useAccount();
  if (!acct.enabled || acct.loading || !acct.user) {
    return (
      <div className="side-context">
        <span className="side-title">Workspace</span>
        <span className="small" style={{ fontWeight: 600 }}>This browser</span>
        <span className="xs muted">Solana {CLUSTER} · drafts and observations stay here</span>
        {acct.enabled && !acct.loading && <Link className="xs link" href="/app/account">Sign in to share with your team</Link>}
      </div>
    );
  }
  return (
    <Link className="side-context side-context-link" href={acct.current ? `/app/w/${acct.current.id}/settings` : "/app/workspace"}>
      <span className="side-title">Workspace</span>
      <span className="small" style={{ fontWeight: 600 }}>{acct.current?.name ?? "Create a workspace"}</span>
      <span className="xs muted">{acct.current ? `${acct.current.role} · Solana ${CLUSTER}` : "to keep and share your work"}</span>
    </Link>
  );
}

/** Sidebar, top bar with the network and the signing wallet, and the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const ws = useAccount().current?.id;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="shell">
      <aside className={`side ${open ? "open" : ""}`} aria-label="App">
        <div className="side-head">
          <Link href="/app" aria-label="Mandate overview"><Wordmark /></Link>
          <button className="icon-btn side-close" onClick={() => setOpen(false)} aria-label="Close menu"><X /></button>
        </div>
        <WorkspaceBlock />
        <Group items={PRIMARY} path={path} ws={ws} />
        <Group title="For operators" items={OPERATORS} path={path} />
        <Group title="Explore" items={EXPLORE} path={path} />
        <div className="side-foot">
          <span className="side-title">Theme</span>
          <ThemeToggle />
        </div>
      </aside>
      {open && <div className="side-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <div className="shell-main">
        <header className="shell-top">
          <button className="icon-btn side-open" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}><Menu /></button>
          <span className="shell-top-brand"><Wordmark size={18} /></span>
          <div className="shell-top-right">
            {CLUSTER !== "mainnet" && <span className="cluster-badge" title="Every agreement here runs on this network"><span className="live-dot" />{CLUSTER}</span>}
            <WalletButton size="sm" />
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
