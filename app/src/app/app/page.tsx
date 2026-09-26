"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, FilePen } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { feedContext, loadBoard, summarize } from "@/lib/loaders";
import { loadFeed } from "@/lib/feed";
import { usePersonas } from "@/lib/personas";
import { CLUSTER } from "@/lib/chain";
import { SlaBoard } from "@/components/board";
import { ActivityFeed } from "@/components/feed";
import { Kpi, Skeleton, TokenPair, duration, fmt } from "@/components/ui";

export default function Network() {
  const now = useNow(5000);
  const book = usePersonas();
  const { data: board, error } = usePoll(loadBoard, [], 12_000);
  const { data: events, error: feedError } = usePoll(() => loadFeed(), [], 10_000);
  const [checks, setChecks] = useState(true);
  const ctx = useMemo(() => feedContext(board, book), [board, book]);
  const sum = board ? summarize(board) : null;
  // Money is shown per quote token; the largest one leads, others are noted rather than added.
  const main = sum?.quotes[0];
  const others = sum ? sum.quotes.length - 1 : 0;
  const unit = main ? `${main.symbol}${others ? ` · plus ${others} other quote token${others === 1 ? "" : "s"}` : ""}` : "";
  const open = board?.rows.filter((r) => r.status === "Open") ?? [];
  const k = (v: React.ReactNode) => (sum ? v : <Skeleton w={56} h={24} />);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Solana {CLUSTER} · read live from the chain</span>
          <h1 className="h1">Network</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            Every liquidity SLA, every check against it and what each one found. Anyone can run a check; the program decides what it means.
          </p>
        </div>
        <Link className="btn btn-primary" href="/app/create"><FilePen />Draft an agreement</Link>
      </div>

      <div className="kpis">
        <Kpi label="Live SLAs" value={k(sum?.active)} sub={sum ? `${sum.open} open to makers` : undefined} />
        <Kpi label="Network uptime" value={k(sum?.compliance === null ? "—" : `${((sum?.compliance ?? 0) * 100).toFixed(1)}%`)} sub={sum ? `${(sum.ok + sum.failed).toLocaleString("en-US")} periods scored` : undefined}
          info="Share of checked periods, across every SLA, in which every obligation was met." />
        <Kpi label="Bonds at stake" value={k(fmt(main?.bonded ?? 0, 0))} sub={main ? `${unit}, posted by makers` : "nothing posted yet"} />
        <Kpi label="Earned by makers" value={k(fmt(main?.fees ?? 0))} sub={main ? `${unit}, for compliant periods` : undefined} />
        <Kpi label="Slashed" value={k(fmt(main?.slashed ?? 0, 0))} sub={main && main.slashed > 0 ? `${unit}, after breaches` : "no breaches yet"} />
      </div>

      {error && !board && <div className="notice warn" style={{ marginTop: 16 }}>Could not reach Solana {CLUSTER}: {error}</div>}

      <div className="network">
        <div className="stack">
          <SlaBoard board={board} book={book} now={now} foot={false} cells={40} />
          {open.length > 0 && board && (
            <div className="card">
              <div className="card-head">
                <span className="h3">Open for makers</span>
                <span className="xs muted">Funded offers waiting for a market maker to accept</span>
              </div>
              {open.map((r) => {
                const t = r.m.terms;
                const quote = board.labels[r.m.quoteMint.toBase58()]?.symbol ?? "quote";
                const d = board.mints[r.m.quoteMint.toBase58()]?.decimals;
                if (d === undefined) return null;
                const q = (v: any) => Number(v) / 10 ** d;
                return (
                  <Link key={r.pubkey.toBase58()} href={`/app/mandate/${r.pubkey.toBase58()}`} className="offer-row">
                    <TokenPair base={r.m.baseMint} quote={r.m.quoteMint} labels={board.labels} size={26} sub={<>Issued by {book.parties[r.m.issuer.toBase58()]?.name ?? "the issuer"}</>} />
                    <span className="small" style={{ color: "var(--ink-2)" }}>
                      <b>{fmt(q(t.feePerPeriod))} {quote}</b> per compliant {duration(t.periodSecs)} · {fmt(q(t.minDepthQuote), 0)} {quote} depth each side · spread ≤ {t.maxSpreadBps} bps · {fmt(q(t.bondAmount), 0)} {quote} bond
                    </span>
                    <span className="link small row" style={{ gap: 4 }}>Review offer <ArrowRight style={{ width: 14, height: 14 }} /></span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="card sticky">
          <div className="card-head">
            <span className="h3 row" style={{ gap: 8 }}><span className="live-dot" />Live activity</span>
            <div className="segmented" role="group" aria-label="Filter activity">
              <button aria-pressed={checks} onClick={() => setChecks(true)}>Everything</button>
              <button aria-pressed={!checks} onClick={() => setChecks(false)}>Key events</button>
            </div>
          </div>
          <div style={{ maxHeight: "min(760px, calc(100vh - 170px))", overflowY: "auto" }}>
            <ActivityFeed events={events} ctx={ctx} showChecks={checks} max={60} error={feedError} />
          </div>
        </div>
      </div>
    </>
  );
}
