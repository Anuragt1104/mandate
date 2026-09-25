"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { loadFeatured, complianceOf } from "@/lib/loaders";
import { ComplianceTape, LiquidityChart } from "./charts";
import { Skeleton, StatusIcon, StatusPill, TokenPair, ago, fmt, fmtPrice } from "./ui";

/** A real mandate on devnet, refreshed in place: the product proving itself on the landing page. */
export function LiveContract() {
  const { data, error } = usePoll(loadFeatured, [], 15_000);
  const now = useNow();

  if (!data) {
    return (
      <div className="live-card" aria-busy={!error}>
        <div className="live-card-head"><Skeleton w={180} h={18} /><Skeleton w={90} h={22} /></div>
        <div className="live-card-body" style={{ display: "grid", gap: 14 }}>
          <Skeleton w="60%" h={20} />
          <Skeleton h={190} />
        </div>
        <div className="live-card-foot"><Skeleton h={34} /></div>
        {error && <div className="notice subtle" style={{ margin: 16 }}>The live devnet feed is unavailable right now ({error}).</div>}
      </div>
    );
  }

  const { m, book, entries, labels, status, key } = data;
  const t = m.terms;
  const qd = book?.quoteDecimals ?? 6;
  const q = (v: any) => Number(v.toString()) / 10 ** qd;
  const last = m.last;
  const checked = m.snapshotsTotal > 0;
  const base = labels[m.baseMint.toBase58()]?.symbol ?? "base";
  const quote = labels[m.quoteMint.toBase58()]?.symbol ?? "quote";
  const rate = complianceOf(m);
  const spreadOk = checked && last.spreadBps <= t.maxSpreadBps;
  const bidOk = checked && last.bidDepthQuote.gte(t.minDepthQuote);
  const askOk = checked && last.askDepthQuote.gte(t.minDepthQuote);

  return (
    <div className="live-card">
      <div className="live-card-head">
        <span className="row small" style={{ gap: 8, fontWeight: 580 }}>
          <span className="live-dot" />
          Live on Solana devnet
          {checked && <span className="muted hide-xs" style={{ fontWeight: 450 }}>· checked {ago(now - last.ts.toNumber())}</span>}
        </span>
        <StatusPill status={status} />
      </div>
      <div className="live-card-body" style={{ display: "grid", gap: 14 }}>
        <div className="row-between wrap">
          <TokenPair base={m.baseMint} quote={m.quoteMint} labels={labels} size={26} sub={`${m.periodsOk + m.periodsFailed + m.periodsUnobserved} periods scored`} />
          <div className="chart-head">
            <div className="chart-stat"><span className="k">Reference price</span><span className="v">{fmtPrice(book?.refUi ?? 0)}</span></div>
            <div className="chart-stat"><span className="k">Compliance</span><span className="v">{rate === null ? "—" : `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`}</span></div>
          </div>
        </div>
        {book && (
          <LiquidityChart bins={book.bins} refBin={book.refBin} activeBin={book.pair.activeId} binStep={book.pair.binStep} refUi={book.refUi}
            depthWindowBps={t.depthWindowBps} quoteSymbol={quote} baseSymbol={base} height={190} maxBins={44} />
        )}
      </div>
      <div className="live-checks">
        <div>
          <span className="row xs muted" style={{ gap: 6 }}><StatusIcon pass={checked ? spreadOk : null} />Spread</span>
          <span className="num" style={{ fontWeight: 640, fontSize: 15 }}>{checked ? (last.spreadBps === 65535 ? "One side empty" : `${last.spreadBps} bps`) : "—"}</span>
          <span className="xs faint">max {t.maxSpreadBps} bps</span>
        </div>
        <div>
          <span className="row xs muted" style={{ gap: 6 }}><StatusIcon pass={checked ? bidOk : null} />Bids committed</span>
          <span className="num" style={{ fontWeight: 640, fontSize: 15 }}>{checked ? `${fmt(q(last.bidDepthQuote))} ${quote}` : "—"}</span>
          <span className="xs faint">min {fmt(q(t.minDepthQuote))} within {t.depthWindowBps / 100}%</span>
        </div>
        <div>
          <span className="row xs muted" style={{ gap: 6 }}><StatusIcon pass={checked ? askOk : null} />Asks committed</span>
          <span className="num" style={{ fontWeight: 640, fontSize: 15 }}>{checked ? `${fmt(q(last.askDepthQuote))} ${quote}` : "—"}</span>
          <span className="xs faint">min {fmt(q(t.minDepthQuote))} within {t.depthWindowBps / 100}%</span>
        </div>
      </div>
      <div className="live-card-foot">
        <ComplianceTape entries={entries} live={status === "Active" && m.curSnapshots > 0 ? { period: m.currentPeriod, failed: m.curFailedSnapshots > 0, snapshots: m.curSnapshots } : null}
          total={t.durationPeriods} cells={44} size="md" quoteDecimals={qd} quoteSymbol={quote} />
        <div className="row-between small">
          <span className="muted"><b style={{ color: "var(--ink)" }}>{m.periodsOk}</b> compliant · <b style={{ color: "var(--ink)" }}>{m.periodsFailed}</b> failed · paid {fmt(q(m.feesEarned))} {quote}</span>
          <Link className="link row" style={{ gap: 4 }} href={`/app/mandate/${key.toBase58()}`}>Open mandate <ArrowRight style={{ width: 14, height: 14 }} /></Link>
        </div>
      </div>
    </div>
  );
}
