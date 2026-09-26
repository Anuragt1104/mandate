"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowRight, FilePen, Radar, Wrench } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { loadBoard } from "@/lib/loaders";
import { usePersonas } from "@/lib/personas";
import { listDrafts, listSessions, type DraftEntry, type SessionEntry } from "@/lib/local";
import { CLUSTER } from "@/lib/chain";
import { SlaBoard } from "@/components/board";
import { Freshness } from "@/components/state";
import { StatusChip, nameOf } from "@/components/sla";
import { slaStatus } from "@/lib/sla";
import { TokenPair, ago, countdown } from "@/components/ui";

/**
 * Where a token team starts: check the arrangement it already pays for, or draft an agreement
 * with its operator. Its own agreements, reports and drafts follow; the live network is proof,
 * not the point.
 */
export default function Overview() {
  const { publicKey } = useWallet();
  const book = usePersonas();
  const now = useNow(15_000);
  const boardPoll = usePoll(loadBoard, [], 20_000);
  const board = boardPoll.data;
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  useEffect(() => {
    setSessions(listSessions().slice(0, 4));
    setDrafts(listDrafts().slice(0, 4));
  }, []);
  const me = publicKey?.toBase58();
  const mine = board?.rows.filter((r) => me && (r.m.issuer.toBase58() === me || r.m.maker.toBase58() === me)) ?? [];

  // What needs a person now: drafts waiting on an approval, observations that stopped, and
  // agreements of the connected wallet that are failing or ending.
  const attention: { key: string; text: string; href: string; action: string }[] = [];
  for (const d of drafts) if (/awaiting|approved/i.test(d.status) && !/both/i.test(d.status)) attention.push({ key: `d${d.id}`, text: `${d.title}: ${d.status.toLowerCase()}`, href: d.link, action: "Review" });
  for (const x of sessions) if (now - x.updatedAt > 900) attention.push({ key: `s${x.id}`, text: `Observation of ${x.label} paused ${ago(now - x.updatedAt)} (its tab was closed)`, href: `/app/monitor?s=${x.id}`, action: "Resume" });
  for (const r of mine) {
    if (r.status !== "Active") continue;
    const sym = board!.labels[r.m.baseMint.toBase58()]?.symbol ?? "token";
    if (r.m.snapshotsTotal > 0 && !r.m.last.ok) attention.push({ key: `f${r.pubkey.toBase58()}`, text: `${sym}: the last check failed`, href: `/app/mandate/${r.pubkey.toBase58()}`, action: "Inspect" });
    const left = r.m.endTs.toNumber() - now;
    if (left > 0 && left < 0.1 * r.m.terms.durationPeriods * r.m.terms.periodSecs) attention.push({ key: `e${r.pubkey.toBase58()}`, text: `${sym}: the term ends in ${countdown(left)}`, href: `/app/mandate/${r.pubkey.toBase58()}/report`, action: "Review renewal" });
  }
  const returning = sessions.length + drafts.length + mine.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Accountable liquidity management</span>
          <h1 className="h1">Start with the arrangement you already have</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
            See what your operator actually delivers, then agree terms both of you can meet, with your inventory in a vault the operator can only quote from and payment that follows the checks.
          </p>
        </div>
      </div>

      {attention.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head"><span className="h3">Needs attention</span><span className="xs muted">{attention.length}</span></div>
          <div className="card-body" style={{ display: "grid", gap: 8 }}>
            {attention.slice(0, 6).map((a) => (
              <div key={a.key} className="row-between" style={{ gap: 12 }}>
                <span className="small">{a.text}</span>
                <Link className="btn btn-secondary btn-sm" href={a.href}>{a.action}</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={`entry-grid ${returning ? "compact" : ""}`} style={{ marginBottom: 20 }}>
        <Link className="entry" href="/app/monitor">
          <span className="row" style={{ gap: 8 }}><Radar style={{ width: 18 }} /><span className="eyebrow">No wallet, no deposit</span></span>
          <span className="h2">Monitor an existing arrangement</span>
          <span className="small muted">Paste your pool or your operator&apos;s position. Mandate samples it at random times with the program&apos;s own arithmetic and builds a service report you can share.</span>
          <span className="link small row" style={{ gap: 4 }}>Start observing <ArrowRight style={{ width: 14 }} /></span>
        </Link>
        <Link className="entry" href="/app/draft">
          <span className="row" style={{ gap: 8 }}><FilePen style={{ width: 18 }} /><span className="eyebrow">Negotiate before any money moves</span></span>
          <span className="h2">Draft with my operator</span>
          <span className="small muted">Propose terms, see what each side commits and how the rules would have played out, send a private link, and fund only once both sides sign identical terms.</span>
          <span className="link small row" style={{ gap: 4 }}>Start a draft <ArrowRight style={{ width: 14 }} /></span>
        </Link>
      </div>

      <div className="grid-halves" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-head"><span className="h3">Your agreements</span><Link className="xs link" href="/app/agreements">All agreements</Link></div>
          <div className="card-body" style={{ display: "grid", gap: 10 }}>
            {!me && <span className="small muted">Connect your wallet to see agreements you issued or operate.</span>}
            {me && mine.length === 0 && <span className="small muted">None for this wallet on {CLUSTER}.</span>}
            {mine.slice(0, 5).map((r) => {
              const qd = board!.mints[r.m.quoteMint.toBase58()]?.decimals;
              const s = slaStatus(r.m, r.status, now, { maker: nameOf(book, r.m.maker, "the operator"), quote: board!.labels[r.m.quoteMint.toBase58()]?.symbol ?? "quote", decimals: qd }, ago);
              return (
                <Link key={r.pubkey.toBase58()} className="row-between" href={`/app/mandate/${r.pubkey.toBase58()}`} style={{ gap: 10 }}>
                  <TokenPair base={r.m.baseMint} quote={r.m.quoteMint} labels={board!.labels} size={22} sub={<>{r.m.issuer.toBase58() === me ? "you issued" : "you operate"}</>} />
                  <StatusChip tone={s.tone} word={s.word} />
                </Link>
              );
            })}
            {me && <Link className="xs link row" style={{ gap: 4 }} href="/app/operator"><Wrench style={{ width: 12 }} />Operator work queue</Link>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><span className="h3">Reports and drafts</span><Link className="xs link" href="/app/reports">All reports</Link></div>
          <div className="card-body" style={{ display: "grid", gap: 10 }}>
            {sessions.length + drafts.length === 0 && <span className="small muted">Nothing yet in this browser. Observations and drafts you start or open appear here.</span>}
            {sessions.map((s) => (
              <Link key={s.id} className="row-between small" href={`/app/monitor?s=${s.id}`}><span><Radar style={{ width: 13, verticalAlign: -2 }} /> {s.label}</span><span className="xs muted">{s.samples} samples · {ago(Math.max(0, now - s.updatedAt))}</span></Link>
            ))}
            {drafts.map((d) => (
              <Link key={d.id} className="row-between small" href={d.link}><span><FilePen style={{ width: 13, verticalAlign: -2 }} /> {d.title}</span><span className="xs muted">{d.status}</span></Link>
            ))}
          </div>
        </div>
      </div>

      <div className="row-between" style={{ margin: "4px 0 10px" }}>
        <span className="h3">Running on {CLUSTER} now</span>
        <Freshness updatedAt={boardPoll.updatedAt} now={now} />
      </div>
      <SlaBoard board={board ?? null} book={book} now={now} limit={4} cells={40} title={`${board?.rows.filter((r) => r.status === "Active").length ?? 0} agreements running · simulated participants`} />
    </>
  );
}
