"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { FileText, Plus } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { complianceOf, loadBoard, summarize, type BoardRow } from "@/lib/loaders";
import { CLUSTER } from "@/lib/chain";
import { ComplianceTape } from "@/components/charts";
import { Identicon, InfoTip, Kpi, Skeleton, StatusIcon, StatusPill, TokenPair, ago, duration, fmt, shortAddr } from "@/components/ui";

type Filter = "all" | "active" | "open" | "ended";
const FILTERS: { id: Filter; label: string; match: (r: BoardRow) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "active", label: "Active", match: (r) => r.status === "Active" },
  { id: "open", label: "Open to makers", match: (r) => r.status === "Open" },
  { id: "ended", label: "Ended", match: (r) => ["Breached", "Expired", "Settled", "Cancelled"].includes(r.status) },
];

export default function Mandates() {
  const router = useRouter();
  const now = useNow(5000);
  const { data, error } = usePoll(loadBoard, [], 15_000);
  const [filter, setFilter] = useState<Filter>("all");
  const rows = data?.rows ?? [];
  const labels = data?.labels ?? {};
  const sum = useMemo(() => summarize(rows), [rows]);
  const visible = rows.filter(FILTERS.find((f) => f.id === filter)!.match);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="h1">Mandates</h1>
          <p className="sub">Market-making contracts on Solana {CLUSTER}. Every figure below is read from the chain and updates every 15 seconds.</p>
        </div>
        <Link className="btn btn-primary" href="/app/create"><Plus />New mandate</Link>
      </div>

      <div className="kpis" style={{ marginBottom: 20 }}>
        <Kpi label="Active mandates" value={data ? sum.active : <Skeleton w={40} h={24} />} sub={data ? `${sum.open} open to makers` : undefined} />
        <Kpi label="Compliance" value={data ? (sum.compliance === null ? "—" : `${(sum.compliance * 100).toFixed(1)}%`) : <Skeleton w={60} h={24} />}
          sub={data ? `${sum.ok + sum.failed} periods scored` : undefined} info="Share of observed periods in which every check passed, across all mandates." />
        <Kpi label="Fees paid to makers" value={data ? fmt(sum.fees) : <Skeleton w={60} h={24} />} sub="in quote tokens" />
        <Kpi label="Bonds at stake" value={data ? fmt(sum.bonded, 0) : <Skeleton w={60} h={24} />} sub="posted by makers" />
        <Kpi label="Bonds slashed" value={data ? fmt(sum.slashed, 0) : <Skeleton w={40} h={24} />} sub={sum.slashed > 0 ? "after breaches" : "no breaches"} />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="segmented" role="group" aria-label="Filter mandates">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}<span className="count">{rows.filter(f.match).length}</span>
              </button>
            ))}
          </div>
          {error && data && <span className="xs muted">Showing the last loaded data. {error}</span>}
        </div>

        {!data && !error && (
          <div style={{ padding: 20, display: "grid", gap: 14 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>
        )}
        {!data && error && <div className="empty-state"><span>Could not reach Solana {CLUSTER}: {error}</span></div>}
        {data && visible.length === 0 && (
          <div className="empty-state">
            <FileText />
            <span className="h3" style={{ color: "var(--ink)" }}>No mandates here yet</span>
            <span className="small">Create one for your token, or switch the filter.</span>
            <Link className="btn btn-secondary btn-sm" href="/app/create"><Plus />New mandate</Link>
          </div>
        )}
        {visible.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Status</th>
                  <th>Market maker</th>
                  <th>Compliance</th>
                  <th className="r">Latest check</th>
                  <th className="r">Bids / asks committed</th>
                  <th className="r">Terms</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const m = r.m;
                  const t = m.terms;
                  const quote = labels[m.quoteMint.toBase58()]?.symbol ?? "";
                  const rate = complianceOf(m);
                  const checked = m.snapshotsTotal > 0;
                  const open = (m.maker as PublicKey).equals(PublicKey.default);
                  return (
                    <tr key={r.pubkey.toBase58()} className="clickable" onClick={() => router.push(`/app/mandate/${r.pubkey.toBase58()}`)}>
                      <td>
                        <Link href={`/app/mandate/${r.pubkey.toBase58()}`} onClick={(e) => e.stopPropagation()}>
                          <TokenPair base={m.baseMint} quote={m.quoteMint} labels={labels} sub={`${duration(t.periodSecs)} periods · ${t.durationPeriods} total`} />
                        </Link>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td>
                        {open ? <span className="muted small">Any maker can accept</span> : (
                          <span className="row" style={{ gap: 8 }}><Identicon address={m.maker} size={20} /><span className="mono">{shortAddr(m.maker)}</span></span>
                        )}
                      </td>
                      <td style={{ minWidth: 170 }}>
                        {r.status === "Open" ? <span className="small muted">Starts when a maker accepts</span> : (
                          <div style={{ display: "grid", gap: 5 }}>
                            <ComplianceTape entries={r.entries} live={r.status === "Active" && m.curSnapshots > 0 ? { period: m.currentPeriod, failed: m.curFailedSnapshots > 0, snapshots: m.curSnapshots } : null}
                              cells={28} size="sm" />
                            <span className="xs muted">{rate === null ? "No periods scored yet" : `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}% · ${m.periodsOk + m.periodsFailed} periods`}</span>
                          </div>
                        )}
                      </td>
                      <td className="r">
                        {checked ? (
                          <span style={{ display: "inline-grid", justifyItems: "end", gap: 2 }}>
                            <span className="row" style={{ gap: 6 }}><StatusIcon pass={m.last.ok} /><span className="num" style={{ fontWeight: 600 }}>{m.last.spreadBps === 65535 ? "One side empty" : `${m.last.spreadBps} bps`}</span></span>
                            <span className="xs muted">{ago(now - m.last.ts.toNumber())}</span>
                          </span>
                        ) : <span className="muted small">Not checked yet</span>}
                      </td>
                      <td className="r num">
                        {checked ? <span><span style={{ color: "var(--bid)", fontWeight: 600 }}>{fmt(Number(m.last.bidDepthQuote) / 1e6)}</span><span className="faint"> / </span><span style={{ color: "var(--ask)", fontWeight: 600 }}>{fmt(Number(m.last.askDepthQuote) / 1e6)}</span> <span className="xs muted">{quote}</span></span> : <span className="muted">—</span>}
                      </td>
                      <td className="r">
                        <span style={{ display: "inline-grid", justifyItems: "end", gap: 2 }}>
                          <span className="num" style={{ fontWeight: 600 }}>{fmt(Number(t.feePerPeriod) / 1e6)} {quote} <span className="muted" style={{ fontWeight: 450 }}>/ period</span></span>
                          <span className="xs muted num">{fmt(Number(t.bondAmount) / 1e6, 0)} {quote} bond</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="xs faint" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6 }}>
        Amounts are in each mandate&apos;s quote token.
        <InfoTip>Bids and asks are the liquidity the maker has committed within the depth window around the reference price at the latest check.</InfoTip>
      </p>
    </>
  );
}
