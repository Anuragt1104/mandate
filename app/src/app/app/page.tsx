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
import { StatusChip, nameOf } from "@/components/sla";
import { slaStatus } from "@/lib/sla";
import { TokenPair, ago } from "@/components/ui";

/**
 * Where a token team starts: check the arrangement it already pays for, or draft an agreement
 * with its operator. Its own agreements, reports and drafts follow; the live network is proof,
 * not the point.
 */
export default function Overview() {
  const { publicKey } = useWallet();
  const book = usePersonas();
  const now = useNow(15_000);
  const { data: board } = usePoll(loadBoard, [], 20_000);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  useEffect(() => {
    setSessions(listSessions().slice(0, 4));
    setDrafts(listDrafts().slice(0, 4));
  }, []);
  const me = publicKey?.toBase58();
  const mine = board?.rows.filter((r) => me && (r.m.issuer.toBase58() === me || r.m.maker.toBase58() === me)) ?? [];

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

      <div className="entry-grid" style={{ marginBottom: 20 }}>
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

      <SlaBoard board={board} book={book} now={now} limit={4} cells={40} title={`Live on ${CLUSTER}: agreements running now`} />
    </>
  );
}
