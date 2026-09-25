"use client";

import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { ArrowRight } from "lucide-react";
import type { Board } from "@/lib/loaders";
import { boardOrder } from "@/lib/loaders";
import { boardTicks, pct, rating, slaStatus, uptime } from "@/lib/sla";
import type { PersonaBook } from "@/lib/personas";
import { Grade, Party, StatusChip, TickLegend, Ticks, nameOf } from "./sla";
import { Skeleton, TokenPair, ago } from "./ui";

/** The network at a glance: one row per SLA with its recent periods as ticks. */
export function SlaBoard({ board, book, now, cells = 48, limit, foot = true, title }: { board: Board | null; book: PersonaBook; now: number; cells?: number; limit?: number; foot?: boolean; title?: string }) {
  if (!board) {
    return (
      <div className="board" aria-busy="true">
        <div className="board-head"><Skeleton w={260} h={20} /><Skeleton w={220} h={14} /></div>
        {[0, 1, 2].map((i) => (
          <div className="board-row" key={i}><Skeleton w={150} h={26} /><Skeleton w={120} h={18} /><Skeleton h={22} /><Skeleton w={50} h={16} /><Skeleton w={100} h={24} /></div>
        ))}
      </div>
    );
  }
  const rows = boardOrder(board.rows).filter((r) => r.status !== "Cancelled");
  const shown = limit ? rows.slice(0, limit) : rows;
  const live = rows.filter((r) => r.status === "Active");
  const statuses = live.map((r) => slaStatus(r.m, r.status, now, { maker: "", quote: "" }, ago));
  const operational = statuses.filter((s) => s.tone === "up").length;
  const starting = statuses.filter((s) => s.tone === "open").length;
  const tone = statuses.some((s) => s.tone === "warn") ? "warn" : "";
  const summary = !live.length
    ? "No live SLAs right now"
    : operational === live.length
      ? `All ${live.length} live SLA${live.length === 1 ? "" : "s"} operational`
      : `${operational} of ${live.length} live SLAs operational${starting ? `, ${starting} starting` : ""}`;

  return (
    <div className="board">
      <div className="board-head">
        <div className="board-summary">
          <span className={`big-dot ${tone}`} />
          {title ?? summary}
        </div>
        <TickLegend />
      </div>
      {shown.map((r) => {
        const m = r.m;
        const quote = board.labels[m.quoteMint.toBase58()]?.symbol ?? "quote";
        const makerName = nameOf(book, m.maker, "The maker");
        const s = slaStatus(m, r.status, now, { maker: makerName, quote }, ago);
        const open = (m.maker as PublicKey).equals(PublicKey.default);
        const profile = board.profiles[m.maker.toBase58()];
        const up = uptime(r.entries);
        return (
          <Link className="board-row" key={r.pubkey.toBase58()} href={`/app/mandate/${r.pubkey.toBase58()}`}>
            <span className="b-pair"><TokenPair base={m.baseMint} quote={m.quoteMint} labels={board.labels} size={26}
              sub={<>Issued by {nameOf(book, m.issuer, "an issuer")}</>} /></span>
            <span className="who row" style={{ gap: 8, minWidth: 0 }}>
              {open ? <span className="small muted">Open to any maker</span> : <><Party address={m.maker} book={book} link={false} />{profile && <Grade r={rating(profile)} />}</>}
            </span>
            <div className="track">
              {r.status === "Open"
                ? <span className="small muted">Waiting for a maker · {Number(m.terms.feePerPeriod) / 1e6} {quote} per compliant period · {Number(m.terms.bondAmount) / 1e6} {quote} bond</span>
                : <Ticks ticks={boardTicks(m, r.status, r.entries, cells)} label="Recent periods" />}
            </div>
            <span className="uptime" title="Share of checked periods that met every obligation">{r.status === "Open" ? "" : pct(up)}</span>
            <span className="state"><StatusChip tone={s.tone} word={s.word} /></span>
          </Link>
        );
      })}
      {foot && (
        <div className="board-foot">
          <span className="xs muted">Each tick is one scoring period (one minute on the test network). Names marked SIM are simulated participants making real transactions.</span>
          <Link className="link small row" style={{ gap: 4 }} href="/app">Open the network <ArrowRight style={{ width: 14, height: 14 }} /></Link>
        </div>
      )}
    </div>
  );
}
