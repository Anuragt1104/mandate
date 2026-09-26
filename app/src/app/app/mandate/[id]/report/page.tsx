"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { ArrowLeft, ArrowRightLeft, FilePen, RefreshCw } from "lucide-react";
import { applyProposals, gapsOf, incidentsOf, proposeChanges, type LogPeriod, type Proposal } from "../../../../../../../sdk/src/renewal";
import { executable } from "../../../../../../../sdk/src/measure";
import type { DraftTerms } from "../../../../../../../sdk/src/draft";
import { usePoll, useNow } from "@/lib/hooks";
import { loadMandate, type MandateView } from "@/lib/loaders";
import { loadHistory, type History } from "@/lib/history";
import { CLUSTER, explorerUrl, fetchAllMandates } from "@/lib/chain";
import { prefillLink } from "@/lib/drafts";
import { usePersonas } from "@/lib/personas";
import { nameOf } from "@/components/sla";
import { PeriodStrip } from "@/components/report";
import { Skeleton, duration, fmt, shortAddr } from "@/components/ui";

export default function RenewalReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(id);
  } catch {
    /* invalid */
  }
  const { data: v, error } = usePoll(async () => (key ? await loadMandate(key) : null), [id], 30_000);
  const { data: h } = usePoll(async () => (key ? await loadHistory(key) : null), [id], 120_000);
  const { data: all } = usePoll(fetchAllMandates, [], 60_000);
  if (!key) return <div className="notice warn">That isn&apos;t an agreement address.</div>;
  if (!v) return error ? <div className="notice warn">Couldn&apos;t load the agreement: {error}</div> : <div className="stack"><Skeleton h={40} /><Skeleton h={200} /><Skeleton h={300} /></div>;
  return <Report v={v} h={h ?? null} successors={(all ?? []).filter((r) => r.m.lbPair.equals(v.m.lbPair) && r.m.createdAt.toNumber() > v.m.createdAt.toNumber() && !r.pubkey.equals(v.key))} />;
}

function Report({ v, h, successors }: { v: MandateView; h: History | null; successors: { pubkey: PublicKey; m: any }[] }) {
  const router = useRouter();
  const book = usePersonas();
  const now = useNow(30_000);
  const { key, m, status, entries, balances } = v;
  const t = m.terms;
  const bd = v.mints.base.decimals;
  const qd = v.mints.quote.decimals;
  const Q = (x: any) => Number(x?.toString?.() ?? x) / 10 ** qd;
  const B = (x: any) => Number(x?.toString?.() ?? x) / 10 ** bd;
  const base = v.labels[m.baseMint.toBase58()]?.symbol ?? "tokens";
  const quote = v.labels[m.quoteMint.toBase58()]?.symbol ?? "quote";
  const maker = nameOf(book, m.maker, "the operator");
  const team = nameOf(book, m.issuer, "the team");
  const period = t.periodSecs as number;
  const ended = ["Breached", "Expired", "Settled"].includes(status);

  const log: LogPeriod[] = entries.map((e) => ({ period: e.period, status: e.status, snapshots: e.snapshots, minBid: Q(e.minBidDepth), minAsk: Q(e.minAskDepth), worstSpreadBps: e.worstSpreadBps }));
  const incidents = incidentsOf(log, period, Q(t.minDepthQuote), t.maxSpreadBps);
  const gaps = gapsOf(log);
  const counters = { ok: m.periodsOk as number, failed: m.periodsFailed as number, unobserved: m.periodsUnobserved as number };
  const scored = counters.ok + counters.failed;
  const codes = log.map((e) => (e.status === 1 ? "m" : e.status === 2 ? "x" : "-")).join("");

  // Money, kept apart: what the operator earned, what the team gets back unused, penalties.
  const feeBudget = h?.created ? Q(h.created.feeBudget) : Q(t.feePerPeriod) * t.durationPeriods;
  const earned = Q(m.feesEarned);
  const slashed = Q(m.bondSlashed);
  const unused = Math.max(0, feeBudget - earned);

  // Inventory, beginning and end, valued at the reference then and now.
  const price = (bin: number) => Math.pow(1 + (v.book?.pair.binStep ?? 1) / 10_000, bin) * 10 ** (bd - qd);
  const startBase = h?.created ? B(h.created.baseDeposit) + B(h.routed) : null;
  const startQuote = h?.created ? Q(h.created.quoteDeposit) : null;
  const deployedBase = v.book?.bins.reduce((s, b) => s + b.base, 0) ?? 0;
  const deployedQuote = v.book?.bins.reduce((s, b) => s + b.quote, 0) ?? 0;
  const endBase = h?.settled ? B(h.settled.toIssuerBase) : B(balances[0]) + deployedBase;
  const endQuote = h?.settled ? Q(h.settled.toIssuerQuote) - unused - slashed : Q(balances[1]) + deployedQuote;
  const startPrice = h?.firstCheck ? price(h.firstCheck.anchorBin) : null;
  const endPrice = price(m.last.ts.toNumber() ? m.last.anchorBin : m.anchor.bin);

  // Trader experience now (only while quotes are live).
  const sizes = [Q(t.minDepthQuote) / 5, Q(t.minDepthQuote), Q(t.minDepthQuote) * 4].map((x) => Math.max(10, Math.round(x / 10) * 10));
  const execution = v.book && v.book.bins.length ? sizes.map((s) => ({ s, ...executable(v.book!.bins.map((b) => ({ binId: b.binId, base: b.base, quote: b.quote, price: b.priceUi })), v.book!.pair.activeId, v.book!.refUi, s) })) : null;

  const current: DraftTerms = {
    feePerPeriod: String(Q(t.feePerPeriod)), periodMinutes: String(period / 60), durationPeriods: String(t.durationPeriods), bond: String(Q(t.bondAmount)),
    maxSpreadBps: String(t.maxSpreadBps), minDepth: String(Q(t.minDepthQuote)), depthWindowBps: String(t.depthWindowBps), bandBps: String(t.bandBps),
    twapMinutes: String(t.anchorTwapSecs / 60), speedPctPerMin: String(t.anchorSpeedBpsPerMin / 100), liquidityLockSecs: String(t.liquidityLockSecs),
    maxConsecutiveFailures: String(t.maxConsecutiveFailures), slashPct: String(t.slashBps / 100),
    baseDeposit: String(startBase ?? 0), quoteDeposit: String(startQuote ?? 0),
  };
  const proposals = useMemo(() => proposeChanges({ terms: current, log, counters, breached: slashed > 0, quote }), [entries, m.periodsOk, m.periodsFailed, m.periodsUnobserved, startBase, startQuote]); // eslint-disable-line react-hooks/exhaustive-deps
  // Term changes are on by default; the user's ticks override.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const isChosen = (p: Proposal) => chosen[p.id] ?? !!p.change;
  const selected = proposals.filter(isChosen);

  // Handover: when this agreement stopped, and when (if ever) the next one on the pool started.
  const stoppedAt = ended ? (h?.slashed?.ts ?? h?.settled?.ts ?? m.startTs.toNumber() + (m.currentPeriod as number) * period) : null;
  const next = successors.filter((r) => r.m.startTs.toNumber() > 0).sort((a, b) => a.m.startTs.toNumber() - b.m.startTs.toNumber())[0];
  const gapSecs = stoppedAt ? (next ? Math.max(0, next.m.startTs.toNumber() - stoppedAt) : Math.max(0, now - stoppedAt)) : null;

  async function renew(operator: "same" | "new") {
    const changes = applyProposals(current, operator === "new" ? selected.filter((p) => p.id !== "failures") : selected);
    router.push(
      await prefillLink({
        market: { cluster: CLUSTER, baseMint: m.baseMint.toBase58(), quoteMint: m.quoteMint.toBase58(), lbPair: m.lbPair.toBase58(), referencePool: m.referencePool.toBase58(), base, quote },
        terms: changes,
        team: m.issuer.toBase58(),
        operator: operator === "same" ? m.maker.toBase58() : undefined,
        renews: key.toBase58(),
        evidence: `/app/mandate/${key.toBase58()}/report`,
        title: operator === "same" ? `${base}/${quote} renewal with ${maker}` : `${base}/${quote} with a new operator`,
        basis: operator === "same"
          ? `Renewal of agreement ${shortAddr(key, 4)}. ${selected.length ? `Proposed changes: ${selected.map((p) => p.title.toLowerCase()).join("; ")}.` : "Same terms."} Both sides approve again before anything is funded.`
          : `Handover from agreement ${shortAddr(key, 4)}: the same pool and inventory, a new operator. Invite them with this link.`,
      }),
    );
  }

  const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const row = (k: string, val: React.ReactNode, sub?: React.ReactNode) => (
    <div className="row-between" style={{ gap: 12, alignItems: "baseline" }}>
      <span className="small muted">{k}</span>
      <span className="num" style={{ textAlign: "right" }}><b>{val}</b>{sub && <div className="xs muted" style={{ fontWeight: 400 }}>{sub}</div>}</span>
    </div>
  );

  return (
    <>
      <Link className="crumb" href={`/app/mandate/${key.toBase58()}`}><ArrowLeft />The agreement</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">{ended ? "Closing report" : "Renewal report · term in progress"}</span>
          <h1 className="h1">{base}/{quote}: was it worth paying for?</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {team} and {maker} · {m.startTs.toNumber() ? `from ${fmtDate(m.startTs.toNumber())}` : "not started"}{ended && stoppedAt ? ` to ${fmtDate(stoppedAt)}` : ""} · {status}
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => renew("new")}><ArrowRightLeft />Invite a new operator</button>
          <button className="btn btn-primary" onClick={() => renew("same")}><RefreshCw />Renew with {selected.length ? "these changes" : "the same terms"}</button>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Service</span><span className="xs muted">{counters.ok + counters.failed + counters.unobserved} periods of {duration(period)}</span></div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
                {row("Compliant", counters.ok, scored ? `${((100 * counters.ok) / scored).toFixed(1)}% of checked periods` : undefined)}
                {row("Failed", counters.failed)}
                {row("Not checked", counters.unobserved, "neither paid nor failed")}
              </div>
              {codes && <PeriodStrip codes={codes} periodSecs={period} startedAt={m.startTs.toNumber() + (log[0]?.period ?? 0) * period} cells={168} />}
              <span className="xs muted">The strip shows the last {log.length} periods the program keeps; the counts cover the whole term.</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="h3">Incidents</span><span className="xs muted">{incidents.length} in the last {log.length} periods</span></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {incidents.length === 0 && <span className="small muted">No failed periods in the log.</span>}
              {incidents.map((i) => (
                <div key={i.from} className="row-between" style={{ gap: 12 }}>
                  <span className="small">Periods {i.from + 1}–{i.to + 1}: {i.causes.join(", ") || "an obligation missed"}</span>
                  <span className="xs muted num">{duration(i.durationSecs)} failing · {i.recoveredAfterSecs === null ? (status === "Active" ? "not recovered yet" : "never recovered") : `recovered after ${duration(i.recoveredAfterSecs)}`}</span>
                </div>
              ))}
              {gaps.length > 0 && <span className="xs muted">Unchecked stretches: {gaps.map((g) => `${g.periods} period${g.periods === 1 ? "" : "s"} from ${g.from + 1}`).join(", ")}.</span>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="h3">What traders could execute</span><span className="xs muted">Separate from compliance</span></div>
            <div className="card-body" style={{ display: "grid", gap: 8 }}>
              {execution ? (
                <div className="table-wrap">
                  <table className="table" style={{ fontSize: 13 }}>
                    <thead><tr><th>Trade size</th><th className="r">Buy</th><th className="r">Sell</th></tr></thead>
                    <tbody>{execution.map((r) => <tr key={r.s}><td className="num">{r.s.toLocaleString("en-US")} {quote}</td><td className="r num">{r.buy.cost === null ? "—" : `${(r.buy.cost * 100).toFixed(2)}%${r.buy.filled < 0.999 ? ` · ${Math.round(r.buy.filled * 100)}% filled` : ""}`}</td><td className="r num">{r.sell.cost === null ? "—" : `${(r.sell.cost * 100).toFixed(2)}%${r.sell.filled < 0.999 ? ` · ${Math.round(r.sell.filled * 100)}% filled` : ""}`}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : (
                <span className="small muted">No quotes are live now, so there&apos;s nothing to execute against. For execution over time, observe the pool from Monitor while the agreement runs.</span>
              )}
              <span className="xs muted">Right now, through the operator&apos;s committed book only, before swap fees. Passing committed-depth checks doesn&apos;t guarantee cheap trading, which is why this is reported apart.</span>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Money</span><span className="xs muted">kept apart</span></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {row("Paid to the operator", `${fmt(earned)} ${quote}`, `${fmt(Q(m.feesClaimed))} collected so far`)}
              {row(ended ? "Unused fee budget, back to the team" : "Fee budget not yet earned", `${fmt(unused)} ${quote}`, `of ${fmt(feeBudget)} escrowed`)}
              {row("Penalty from the bond", slashed ? `${fmt(slashed)} ${quote}` : "none", slashed && h?.slashed ? <a className="link" href={explorerUrl(h.slashed.sig)} target="_blank" rel="noreferrer">transaction</a> : undefined)}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="h3">Inventory</span><span className="xs muted">{ended ? "start and return" : "start and now"}</span></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {startBase !== null && startQuote !== null
                ? row("At the start", <>{fmt(startBase, 0)} {base} + {fmt(startQuote, 0)} {quote}</>, startPrice ? `≈ ${fmt(startBase * startPrice + startQuote, 0)} ${quote} at the first check's reference` : undefined)
                : row("At the start", h ? "not available" : "loading…", h && !h.complete ? "the history is too long to read back to the start" : undefined)}
              {status === "Settled" && !h?.settled
                ? row("Returned to the team", h ? "not available" : "loading…")
                : row(ended ? (status === "Settled" ? "Returned to the team" : "In the vaults, to return") : "Now", <>{fmt(endBase, 0)} {base} + {fmt(endQuote, 0)} {quote}</>, `≈ ${fmt(endBase * endPrice + endQuote, 0)} ${quote} at the ${ended ? "last" : "current"} reference`)}
              <span className="xs muted">Valued at the agreement&apos;s reference price at each point, which a thin pool may not realise. Fees and penalties are excluded; trading fees the position earned stay in the inventory.{h?.settled && <> <a className="link" href={explorerUrl(h.settled.sig)} target="_blank" rel="noreferrer">Settlement transaction</a>.</>}</span>
            </div>
          </div>

          {ended && (
            <div className="card">
              <div className="card-head"><span className="h3">Handover</span></div>
              <div className="card-body" style={{ display: "grid", gap: 10 }}>
                {row("Assets", status === "Settled" ? "returned" : "waiting for settlement", status === "Settled" ? "inventory and unused fees to the team" : "anyone can unwind and settle")}
                {next ? row("Next agreement", <Link className="link" href={`/app/mandate/${next.pubkey.toBase58()}`}>{shortAddr(next.pubkey, 4)}</Link>, `with ${nameOf(book, next.m.maker, "an operator")}`) : row("Next agreement", "none yet")}
                {gapSecs !== null && (next && stoppedAt && next.m.startTs.toNumber() <= stoppedAt
                  ? row("Gap without an agreement", "none", "another agreement on this pool was already running")
                  : row(next ? "Gap without an agreement" : "Unmanaged for", duration(gapSecs), next ? "between this one stopping and the next one scoring" : "and counting"))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><span className="h3">Proposed changes for the next term</span></div>
            <div className="card-body" style={{ display: "grid", gap: 12 }}>
              {proposals.length === 0 && <span className="small muted">Not enough history to suggest changes.</span>}
              {proposals.map((p: Proposal) => (
                <label key={p.id} className="row" style={{ gap: 10, alignItems: "flex-start", cursor: p.change ? "pointer" : "default" }}>
                  <input type="checkbox" disabled={!p.change} checked={isChosen(p)} onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.checked })} style={{ marginTop: 4 }} />
                  <span style={{ display: "grid", gap: 2 }}>
                    <b className="small">{p.title}</b>
                    <span className="xs muted">{p.why}</span>
                    {p.change && <span className="xs">{Object.entries(p.change).map(([k, val]) => `${k}: ${(current as any)[k]} → ${val}`).join(" · ")}</span>}
                    {!p.change && p.id === "monitoring" && <span className="xs muted">Agree this outside the terms.</span>}
                  </span>
                </label>
              ))}
              <span className="xs muted">Renewing starts a new draft with the chosen changes; nothing about this agreement changes. Both sides approve again, then the team funds it.</span>
              <button className="btn btn-secondary btn-sm" onClick={() => renew("same")}><FilePen />Draft the renewal</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
