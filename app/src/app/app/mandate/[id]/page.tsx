"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ArrowLeft, CircleAlert, Eye, RefreshCw, Route } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { useMandateActions } from "@/lib/actions";
import { loadMandate, type MandateView } from "@/lib/loaders";
import { connection } from "@/lib/chain";
import { feedStatus, loadFeed } from "@/lib/feed";
import { latestRead as pickRead, trustedWatchtowers } from "@/lib/trust";
import { usePersonas, type PersonaBook } from "@/lib/personas";
import type { FeedEvent } from "@/lib/feed";
import { explorerUrl } from "@/lib/chain";
import { incidents, obligations, pct, rating, roundTrip, slaStatus, uptime } from "@/lib/sla";
import { LiquidityChart, LiquidityLegend } from "@/components/charts";
import { ActivityFeed } from "@/components/feed";
import { AgreementSummary, tokenRisks, ExecutionPanel, Grade, IncidentList, ObligationRows, Party, SentinelCard, SlaBanner, Schedule, StatusChip, TickLegend, judgeName, nameOf, type AgreementFacts } from "@/components/sla";
import { DIAGNOSIS_LABELS } from "../../../../../../sdk/src/sentinel";
import { WalletButton } from "@/components/wallet";
import { Address, InfoTip, Skeleton, StatusIcon, TokenPair, ago, countdown, duration, fmt, fmtFull, fmtPrice, shortAddr } from "@/components/ui";
import { StrategyType, binArrayIndex, dlmmInitBinArrayIx } from "../../../../../../sdk/src";

const ROUND_TRIP_SIZE = 500;
const JUPITER_MAX_LOSS = 0.3;

export default function SlaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(id);
  } catch {
    /* invalid address */
  }
  if (!key) return <NotFound text="That is not a valid SLA address." />;
  return <SlaDetail mandateKey={key} />;
}

function NotFound({ text }: { text: string }) {
  return (
    <div className="card empty-state" style={{ marginTop: 20 }}>
      <CircleAlert />
      <span className="h3" style={{ color: "var(--ink)" }}>SLA not found</span>
      <span className="small">{text}</span>
      <Link className="btn btn-secondary btn-sm" href="/app/agreements"><ArrowLeft />All agreements</Link>
    </div>
  );
}

function SlaDetail({ mandateKey }: { mandateKey: PublicKey }) {
  const id = mandateKey.toBase58();
  const { data, error, reload } = usePoll(async () => (await loadMandate(mandateKey)) ?? ("missing" as const), [id], 10_000);
  const now = useNow();
  if (data === null && !error) {
    return (
      <div className="stack">
        <Skeleton w={120} h={14} />
        <Skeleton w={320} h={40} />
        <Skeleton h={84} />
        <Skeleton h={180} />
        <Skeleton h={300} />
      </div>
    );
  }
  if (data === "missing") return <NotFound text="No SLA exists at this address on this cluster." />;
  if (!data) return <NotFound text={`Could not load it: ${error}`} />;
  return <Detail v={data} now={now} reload={reload} error={error} />;
}

function Detail({ v, now, reload, error }: { v: MandateView; now: number; reload: () => void; error: string | null }) {
  const book = usePersonas();
  const { key, m, status, entries, labels, profile } = v;
  const chart = v.book;
  const t = m.terms;
  const bd = v.mints.base.decimals;
  const qd = v.mints.quote.decimals;
  const q = (x: any) => Number(x.toString()) / 10 ** qd;
  const base = labels[m.baseMint.toBase58()]?.symbol ?? "base";
  const quote = labels[m.quoteMint.toBase58()]?.symbol ?? "quote";
  const openToAll = (m.maker as PublicKey).equals(PublicKey.default);
  const makerName = openToAll ? "The maker" : nameOf(book, m.maker, "The maker");
  const s = slaStatus(m, status, now, { maker: makerName, quote, decimals: qd }, ago);
  const obl = useMemo(() => obligations(m, status, entries, 60, quote, (x) => fmt(x), qd), [m, status, entries, quote, qd]);
  const incs = useMemo(() => incidents(m, status, entries), [m, status, entries]);
  const up = uptime(entries);
  const clockPeriod = Math.min(t.durationPeriods - 1, Math.max(0, Math.floor((now - m.startTs.toNumber()) / t.periodSecs)));
  const periodEnd = m.startTs.toNumber() + (m.currentPeriod + 1) * t.periodSecs;
  const clockPeriodEnd = m.startTs.toNumber() + (clockPeriod + 1) * t.periodSecs;
  const { data: events, error: feedError } = usePoll(() => loadFeed(key, 25), [key.toBase58()], 10_000);
  const trusted = useMemo(() => trustedWatchtowers(book), [book]);
  const ctx = useMemo(() => ({
    book,
    trusted,
    mandates: { [key.toBase58()]: { symbol: base, quote, maker: m.maker, issuer: m.issuer, terms: t, baseDecimals: bd, quoteDecimals: qd } },
  }), [book, trusted, key, base, quote, m.maker, m.issuer, t, bd, qd]);
  const trip = chart ? roundTrip(chart.bins, chart.pair.activeId, ROUND_TRIP_SIZE) : null;
  // The newest current read of this SLA (from a listed watchtower when there is one), and
  // a listed watchtower's read during each incident.
  const shown = useMemo(() => pickRead(events, key.toBase58(), trusted, now), [events, key, trusted, now]);
  const causes = useMemo(() => {
    const out: Record<number, string> = {};
    for (const inc of incs) {
      const ev = events?.find((e) => e.read && trusted.has(e.read.publisher) && e.read.read.mandate === key.toBase58() && e.read.read.diagnosis !== "quoting_normally" && Number(e.data?.period) >= inc.from && Number(e.data?.period) <= inc.to);
      if (ev?.read) out[inc.from] = `${DIAGNOSIS_LABELS[ev.read.read.diagnosis]} (${judgeName(ev.read.read.source)})`;
    }
    return out;
  }, [incs, events, trusted, key]);
  const read = shown?.standing === "trusted" ? shown.v.read : null;
  const history = feedStatus(key);
  const facts: AgreementFacts = {
    base, quote,
    baseDeposit: status === "Open" ? Number(v.balances[0]) / 10 ** bd : null,
    quoteDeposit: status === "Open" ? Number(v.balances[1]) / 10 ** qd : null,
    feeBudget: status === "Open" ? Number(v.balances[2]) / 10 ** qd : null,
    bond: q(t.bondAmount), feePerPeriod: q(t.feePerPeriod), periodSecs: t.periodSecs, periods: t.durationPeriods,
    minDepth: q(t.minDepthQuote), windowPct: t.depthWindowBps / 100, maxSpreadBps: t.maxSpreadBps, bandPct: t.bandBps / 100,
    speedPctPerMin: t.anchorSpeedBpsPerMin / 100, maxFailures: t.maxConsecutiveFailures, slashPct: t.slashBps / 100, lockSecs: t.liquidityLockSecs,
    maker: openToAll ? null : nameOf(book, m.maker, shortAddr(m.maker)),
    designated: status === "Open" && !openToAll,
    endsAt: status === "Active" ? m.endTs.toNumber() : null,
    tokenRisks: tokenRisks({ symbol: base, ...v.mints.base }, { symbol: quote, ...v.mints.quote }),
  };
  const plainWords = (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="h3">The agreement in plain words</span>
        <span className="xs muted">{status === "Open" ? "Read this before accepting" : "What both parties signed up to"}</span>
      </div>
      <div className="card-body"><AgreementSummary f={facts} audience={status === "Open" ? "maker" : "both"} /></div>
    </div>
  );
  const banner = read && status === "Active" && read.diagnosis !== "quoting_normally"
    ? { ...s, detail: `${s.detail} Watchtower read: ${DIAGNOSIS_LABELS[read.diagnosis].toLowerCase()}${isFinite(read.breach) && read.source !== "rules" ? `, breach outlook ${Math.round(read.breach * 100)}%` : ""}.` }
    : s;

  return (
    <>
      <Link className="crumb" href="/app/agreements"><ArrowLeft />Agreements</Link>
      <div className="sla-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Liquidity SLA · {shortAddr(key, 4)}</span>
          <div className="sla-title" style={{ marginTop: 8 }}>
            <TokenPair base={m.baseMint} quote={m.quoteMint} labels={labels} size={40} />
            <StatusChip tone={s.tone} word={s.word} />
          </div>
          <div className="sla-parties">
            <span>Issuer <Party address={m.issuer} book={book} /></span>
            <span>Maker {openToAll ? <b style={{ color: "var(--ink)" }}>open to any maker</b> : <><Party address={m.maker} book={book} />{profile && <Grade r={rating(profile)} />}</>}</span>
            <span className="venue">Venue · Meteora DLMM</span>
            {status === "Active" && <span className="mono xs">Period {(clockPeriod + 1).toLocaleString("en-US")} of {t.durationPeriods.toLocaleString("en-US")}</span>}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
          {error && <span className="xs muted">Showing the last loaded data. {error}</span>}
          {status !== "Open" && status !== "Cancelled" && (
            <Link className="btn btn-secondary btn-sm" href={`/app/mandate/${key.toBase58()}/report`}>{["Breached", "Expired", "Settled"].includes(status) ? "Closing report and handover" : "Renewal report"}</Link>
          )}
        </div>
      </div>

      <SlaBanner s={banner} stat={status === "Open" ? { value: `${fmtFull(q(t.feePerPeriod))} ${quote}`, label: `per compliant ${duration(t.periodSecs)}` } : { value: pct(up), label: `uptime · ${entries.filter((e) => e.status !== 3).length} checked periods` }} />

      {status === "Open" && plainWords}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="h3">Service levels <InfoTip>Each tick is one scoring period. A period pays the maker only if it was checked and every check passed.</InfoTip></span>
          <TickLegend />
        </div>
        {status === "Open" ? (
          <div className="card-body"><div className="notice info">Scoring starts the moment a market maker accepts and posts its bond. From then on, every {duration(t.periodSecs)} period is scored here, obligation by obligation.</div></div>
        ) : <ObligationRows rows={obl.rows} />}
        {status === "Active" && (
          <div className="card-foot row-between wrap">
            <span className="xs muted">Last 60 periods. Hover a tick for its record.</span>
            <span className="xs muted num">Period {clockPeriod + 1} closes in {countdown(clockPeriodEnd - now)}</span>
          </div>
        )}
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="h3">Committed book</span>
              <div className="chart-head">
                <div className="chart-stat"><span className="k"><i className="swatch line" style={{ width: 12 }} />Reference</span><span className="v">{fmtPrice(chart?.refUi ?? 0)}</span></div>
                <div className="chart-stat"><span className="k">Last trade</span><span className="v">{fmtPrice(chart?.activeUi ?? 0)}</span></div>
                <div className="chart-stat"><span className="k">Graduated pool <InfoTip>Price in the DAMM v2 pool the token graduated into. Shown for comparison only: a spot price can be moved within one transaction, so it is never used for enforcement.</InfoTip></span><span className="v">{fmtPrice(chart?.dammUi ?? 0)}</span></div>
              </div>
            </div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              {chart ? (
                <LiquidityChart bins={chart.bins} refBin={chart.refBin} activeBin={chart.pair.activeId} binStep={chart.pair.binStep} refUi={chart.refUi}
                  depthWindowBps={t.depthWindowBps} quoteSymbol={quote} baseSymbol={base} height={240}
                  empty={status === "Open" ? { title: "No quotes yet", body: "Liquidity goes on the pair once a maker accepts." }
                    : status === "Active" ? { title: "No liquidity on the pair", body: `${makerName} has no quotes placed right now.` }
                    : { title: "This SLA has closed", body: "Its liquidity was unwound and every balance paid out." }} />
              ) : <Skeleton h={240} />}
              <LiquidityLegend quoteSymbol={quote} windowBps={t.depthWindowBps} />
              {chart && chart.bins.length > 0 && (
                <div style={{ display: "grid", gap: 8, paddingTop: 6 }}>
                  <span className="h3" style={{ fontSize: 14 }}>What a trader gets right now</span>
                  <ExecutionPanel bins={chart.bins} activeBin={chart.pair.activeId} refUi={chart.refUi} quote={quote}
                    committedOk={status === "Active" && m.snapshotsTotal > 0 ? !!m.last.ok : null} speedPctPerMin={t.anchorSpeedBpsPerMin / 100}
                    sizes={[q(t.minDepthQuote) / 5, q(t.minDepthQuote), q(t.minDepthQuote) * 4].map((x) => Math.max(10, Math.round(x / 10) * 10))} />
                </div>
              )}
              {trip && (
                <div className="notice" style={{ alignItems: "center" }}>
                  <Route />
                  <span style={{ flex: 1 }}>
                    A {ROUND_TRIP_SIZE} {quote} round trip through this book costs <b>{(trip.loss * 100).toFixed(2)}%</b> before swap fees{trip.filled ? "" : ", and the book cannot fill it in full"}.
                    {" "}Jupiter&apos;s routing check allows up to {JUPITER_MAX_LOSS * 100}%.
                  </span>
                  <span className={`tag ${trip.filled && trip.loss < JUPITER_MAX_LOSS ? "pass" : "fail"}`}>{trip.filled && trip.loss < JUPITER_MAX_LOSS ? "Routable" : "Not routable"}</span>
                </div>
              )}
              {chart && status === "Active" && chart.committed.status === "measured" && (
                <div className="notice subtle">
                  At the reference right now, with the program&apos;s own arithmetic: bids {fmt(Number(chart.committed.bidDepth) / 10 ** qd)} {quote}, asks {fmt(Number(chart.committed.askDepth) / 10 ** qd)} {quote}, spread {chart.committed.spreadBps === 65535 ? "not measurable" : `${chart.committed.spreadBps} bps`}.
                  {" "}A check now would <b style={{ color: chart.committed.ok ? "var(--up)" : "var(--down)" }}>{chart.committed.ok ? "pass" : "fail"}</b>, unless the reference moves first.
                </div>
              )}
              {chart && status === "Active" && chart.committed.status === "unknown" && (
                <div className="notice subtle">Can&apos;t predict the next check: {chart.committed.reason}.</div>
              )}
              {chart && status === "Active" && chart.quality !== "ready" && (
                <div className="notice subtle">
                  {chart.quality === "warming" && "The reference is holding still until the pair's oracle has a full clean time-weighted window."}
                  {chart.quality === "tainted" && "Liquidity was just removed from the active bin, so the oracle's recent samples can't be trusted; the reference holds still until a fresh window builds up."}
                  {chart.quality === "stale" && "No trades have updated the pair's oracle for longer than the time-weighted window; the reference follows the last window it had."}
                </div>
              )}
              {chart && chart.targetBin !== chart.refBin && (
                <div className="notice subtle">
                  The time-weighted price is {chart.targetBin > chart.refBin ? "above" : "below"} the reference, so the reference is moving toward it at up to {t.anchorSpeedBpsPerMin / 100}% a minute.
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="h3">Incidents</span>
              <span className="xs muted">{incs.length ? `${incs.length} in the last ${entries.length} periods` : `last ${entries.length} periods`}</span>
            </div>
            <IncidentList items={incs} periodSecs={t.periodSecs} makerName={makerName} slashed={fmt(q(m.bondSlashed))} quote={quote} causes={causes} />
          </div>

          <div className="card">
            <div className="card-head">
              <span className="h3 row" style={{ gap: 8 }}>{status === "Active" && <span className="live-dot" />}Activity</span>
              <span className="xs muted">{history.gap || history.pending ? `From on-chain events · ${history.pending ? `${history.pending} still loading` : "some older activity not shown"}` : "From this SLA's on-chain events"}</span>
            </div>
            <div style={{ maxHeight: 520, overflowY: "auto" }}>
              <ActivityFeed events={events} ctx={ctx} max={40} error={feedError} />
            </div>
          </div>
        </div>

        <div className="stack">
          {status !== "Open" && <SentinelCard shown={shown} now={now} />}
          <LatestCheck v={v} now={now} reload={reload} quote={quote} q={q} />
          <ActionsCard v={v} now={now} reload={reload} periodEnd={periodEnd} book={book} />
          {(status === "Settled" || status === "Breached") && <SettlementReceipt v={v} events={events} base={base} quote={quote} bd={bd} qd={qd} book={book} />}
          <div className="card">
            <div className="card-head"><span className="h3">Escrow</span><span className="xs muted">Held by the program</span></div>
            <div className="card-body">
              <Escrow v={v} bd={bd} qd={qd} base={base} quote={quote} clockPeriod={clockPeriod} />
            </div>
          </div>
        </div>
      </div>

      {status !== "Open" && <div style={{ marginTop: 16 }}>{plainWords}</div>}

      <div className="contract" style={{ marginTop: status === "Open" ? 16 : 0 }}>
        <div className="contract-col">
          <div className="row-between"><span className="h3">The agreement</span><span className="xs muted">Fixed when it was created</span></div>
          <Schedule t={t} quote={quote} decimals={qd} />
        </div>
        <div className="contract-col">
          <span className="h3">Parties and accounts</span>
          <dl className="dl">
            <dt>Issuer</dt><dd><Party address={m.issuer} book={book} /></dd>
            <dt>Maker</dt><dd>{openToAll ? <span className="muted">not yet accepted</span> : <Party address={m.maker} book={book} />}</dd>
            <dt>SLA account</dt><dd><Address value={key} /></dd>
            <dt>DLMM pair</dt><dd><Address value={m.lbPair} /></dd>
            <dt>Oracle</dt><dd><Address value={m.oracle} /></dd>
            <dt>Graduated pool</dt><dd><Address value={m.referencePool} /></dd>
            <dt>Position</dt><dd>{(m.position as PublicKey).equals(PublicKey.default) ? <span className="muted">none open</span> : <Address value={m.position} />}</dd>
            <dt>Base vault</dt><dd><Address value={m.baseVault} /></dd>
            <dt>Quote vault</dt><dd><Address value={m.quoteVault} /></dd>
          </dl>
          <p className="xs muted" style={{ margin: 0 }}>
            The vaults are owned by the SLA account. Inventory can only move into this SLA&apos;s own DLMM position and back, and settlement pays fixed recipients.
          </p>
        </div>
      </div>
    </>
  );
}

function Escrow({ v, bd, qd, base, quote, clockPeriod }: { v: MandateView; bd: number; qd: number; base: string; quote: string; clockPeriod: number }) {
  const { m, status, balances } = v;
  const t = m.terms;
  const owed = Math.max(0, Number(m.feesEarned) - Number(m.feesClaimed));
  const budgetFree = Math.max(0, Number(balances[2]) - owed);
  const coverPeriods = Math.floor(budgetFree / Math.max(1, Number(t.feePerPeriod)));
  const periodsLeft = Math.max(0, t.durationPeriods - clockPeriod - 1);
  const deployedBase = v.book?.bins.reduce((s, b) => s + b.base, 0) ?? 0;
  const deployedQuote = v.book?.bins.reduce((s, b) => s + b.quote, 0) ?? 0;
  return (
    <dl className="dl">
      <dt>Quoted on the pair</dt>
      <dd><span style={{ display: "grid" }}><span>{fmt(deployedBase)} {base}</span><span>{fmt(deployedQuote)} {quote}</span></span></dd>
      <dt>Idle in the vault</dt>
      <dd><span style={{ display: "grid" }}><span>{fmt(Number(balances[0]) / 10 ** bd)} {base}</span><span>{fmt(Number(balances[1]) / 10 ** qd)} {quote}</span></span></dd>
      <dt>Fee budget</dt>
      <dd><span style={{ display: "grid" }}><span>{fmt(budgetFree / 10 ** qd)} {quote}</span>{owed > 0 && <span className="xs muted" style={{ fontWeight: 450 }}>+ {fmt(owed / 10 ** qd)} owed to the maker</span>}</span></dd>
      <dt>Covers</dt>
      <dd style={{ color: status === "Active" && coverPeriods < periodsLeft ? "var(--warn)" : undefined }}>{status === "Active" ? `${Math.min(coverPeriods, periodsLeft).toLocaleString("en-US")} of ${periodsLeft.toLocaleString("en-US")} periods left` : `${coverPeriods.toLocaleString("en-US")} periods`}</dd>
      <dt>Maker bond</dt>
      <dd><span style={{ display: "grid" }}><span>{fmt(Number(balances[3]) / 10 ** qd)} {quote}</span>{Number(m.bondSlashed) > 0 && <span className="xs" style={{ color: "var(--down)", fontWeight: 500 }}>{fmt(Number(m.bondSlashed) / 10 ** qd)} slashed</span>}</span></dd>
      <dt>Paid to the maker</dt>
      <dd>{fmt(Number(m.feesEarned) / 10 ** qd)} {quote}</dd>
    </dl>
  );
}

function LatestCheck({ v, now, reload, quote, q }: { v: MandateView; now: number; reload: () => void; quote: string; q: (x: any) => number }) {
  const { m } = v;
  const t = m.terms;
  const last = m.last;
  const checked = m.snapshotsTotal > 0;
  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Latest check</span>
        <span className="xs muted">{checked ? `${ago(now - last.ts.toNumber())} · ${m.snapshotsTotal.toLocaleString("en-US")} so far` : "Not checked yet"}</span>
      </div>
      <div className="card-body">
        <div className="checks">
          <CheckRow name="Bid depth" pass={checked ? last.bidDepthQuote.gte(t.minDepthQuote) : null}
            value={checked ? `${fmt(q(last.bidDepthQuote))} ${quote}` : "—"}
            target={`at least ${fmt(q(t.minDepthQuote))} within ${t.depthWindowBps / 100}% below the reference`}
            fill={checked ? Math.min(1, q(last.bidDepthQuote) / Math.max(1e-9, q(t.minDepthQuote))) : 0} />
          <CheckRow name="Ask depth" pass={checked ? last.askDepthQuote.gte(t.minDepthQuote) : null}
            value={checked ? `${fmt(q(last.askDepthQuote))} ${quote}` : "—"}
            target={`at least ${fmt(q(t.minDepthQuote))} within ${t.depthWindowBps / 100}% above it`}
            fill={checked ? Math.min(1, q(last.askDepthQuote) / Math.max(1e-9, q(t.minDepthQuote))) : 0} />
          <CheckRow name="Spread" pass={checked ? last.spreadBps <= t.maxSpreadBps : null}
            value={checked ? (last.spreadBps === 65535 ? "One side empty" : `${last.spreadBps} bps`) : "—"}
            target={`at most ${t.maxSpreadBps} bps, at a size of ${fmt(q(t.minDepthQuote) / 10)} ${quote}`}
            fill={checked && last.spreadBps !== 65535 ? Math.min(1, last.spreadBps / Math.max(1, t.maxSpreadBps)) : 1} />
        </div>
      </div>
      <div className="card-foot" style={{ display: "grid", gap: 8 }}>
        <SnapshotButton v={v} reload={reload} />
        <span className="xs muted">Anyone can check the maker, any time, as often as they like. Trading around a check can&apos;t change its result.</span>
      </div>
    </div>
  );
}

function CheckRow({ name, pass, value, target, fill }: { name: string; pass: boolean | null; value: string; target: string; fill: number }) {
  return (
    <div className="check">
      <span className="check-name"><StatusIcon pass={pass} />{name}</span>
      <span className="check-value" style={{ color: pass === false ? "var(--down)" : undefined }}>{value}</span>
      <span className="check-target">{target}</span>
      <span className={`meter ${pass === false ? "fail" : ""}`} aria-hidden="true"><span style={{ width: `${Math.max(2, fill * 100)}%` }} /></span>
    </div>
  );
}

function SnapshotButton({ v, reload }: { v: MandateView; reload: () => void }) {
  const { run, busy, me } = useMandateActions();
  const active = v.status === "Active";
  if (!me) return <WalletButton />;
  return (
    <button className="btn btn-secondary btn-block" disabled={!active || !!busy}
      onClick={() => run("Check", async (c, me, fm) => [await c.snapshot({ cranker: me, mandate: v.key, m: fm ?? v.m })], { done: "Check recorded on-chain.", mandate: v.key }).then(() => setTimeout(reload, 500))}>
      <RefreshCw />
      {busy === "Check" ? "Checking…" : active ? "Check the maker now" : "Checks run while the SLA is live"}
    </button>
  );
}

function ActionsCard({ v, now, reload, periodEnd, book }: { v: MandateView; now: number; reload: () => void; periodEnd: number; book: PersonaBook }) {
  const { me, run, busy } = useMandateActions();
  const [pctDeploy, setPctDeploy] = useState(90);
  const [halfWidth, setHalfWidth] = useState(8);
  const { key, m, status, balances } = v;
  const chart = v.book;
  const t = m.terms;
  const qd = v.mints.quote.decimals;
  const isMaker = !!me && (m.maker as PublicKey).equals(me);
  const isIssuer = !!me && (m.issuer as PublicKey).equals(me);
  const openToAll = (m.maker as PublicKey).equals(PublicKey.default);
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);
  const earned = (Number(m.feesEarned) - Number(m.feesClaimed)) / 10 ** qd;
  const maxFees = Number(t.feePerPeriod) * t.durationPeriods;
  const underfunded = status === "Open" && Number(balances[2]) < maxFees;
  const after = () => setTimeout(reload, 500);

  const accept = () =>
    run("Accept", async (c, me, fm) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, me, true), me, m.quoteMint),
      await c.accept({ maker: me, mandate: key, m: fm ?? m }),
    ], { done: "SLA accepted. Your bond is posted; scoring starts after the one-minute setup window.", mandate: key }).then(after);
  const cancel = () => run("Cancel", async (c, _me, fm) => [await c.cancel({ mandate: key, m: fm ?? m })], { done: "Offer cancelled. Funds returned to you.", mandate: key }).then(after);
  const finalize = () => run("Finalize", async (c, _me, fm) => [await c.finalize({ mandate: key, m: fm ?? m })], { done: "Elapsed periods closed out.", mandate: key }).then(after);
  const openPosition = () =>
    run("Open position", async (c, me, fm) => {
      const lower = chart!.refBin - 35;
      const ixs = [];
      for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + 69); i++) ixs.push(dlmmInitBinArrayIx(m.lbPair, i, me));
      const infos = await connection().getMultipleAccountsInfo(ixs.map((ix) => ix.keys[1].pubkey));
      return [...ixs.filter((_, i) => !infos[i]), await c.openPosition({ maker: me, mandate: key, m: fm ?? m, lowerBinId: lower, width: 70 })];
    }, { done: "Position opened around the reference price.", mandate: key }).then(after);
  const deploy = () =>
    run("Deploy", async (c, me, fm) => {
      const m = fm ?? v.m;
      const pair = chart!.pair;
      const ref = chart!.refBin;
      const bandBins = Math.floor(Math.log(1 + t.bandBps / 10_000) / Math.log(1 + pair.binStep / 10_000)) - 1;
      const lower = m.positionLowerBinId as number;
      const upper = lower + (m.positionWidth as number) - 1;
      const lo = Math.max(ref - Math.min(halfWidth, bandBins), lower);
      const hi = Math.min(ref + Math.min(halfWidth, bandBins), upper);
      const f = BigInt(pctDeploy);
      const ixs = [];
      const bidMax = Math.min(ref + 1, pair.activeId, hi);
      if (balances[1] > 0n && lo <= bidMax)
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(0), amountQuote: new BN(((balances[1] * f) / 100n).toString()), minBinId: lo, maxBinId: bidMax, strategy: StrategyType.SpotImBalanced }));
      const askMin = Math.max(ref, pair.activeId, lo);
      if (balances[0] > 0n && askMin <= hi)
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(((balances[0] * f) / 100n).toString()), amountQuote: new BN(0), minBinId: askMin, maxBinId: hi, strategy: StrategyType.SpotImBalanced }));
      if (!ixs.length) throw new Error("Nothing to deploy: the vault is empty or no bins are allowed right now.");
      return ixs;
    }, { done: "Inventory placed as bids and asks around the reference.", mandate: key }).then(after);
  const pull = (close: boolean) =>
    run(close ? "Unwind" : "Withdraw", async (c, me, fm) => {
      const ixs = [await c.removeLiquidity({ authority: me, mandate: key, m: fm ?? m, pair: chart!.pair })];
      if (close) ixs.push(await c.closePosition({ authority: me, mandate: key, m: fm ?? m }));
      return ixs;
    }, { done: close ? "Liquidity returned to the vault and the position closed." : "Liquidity returned to the vault.", mandate: key }).then(after);
  const claim = () => run("Claim", async (c, _me, fm) => [await c.claimMakerFees({ mandate: key, m: fm ?? m })], { done: "Earned fees sent to your wallet.", mandate: key }).then(after);
  const settle = () =>
    run("Settle", async (c, me, fm) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.baseMint, m.issuer, true), m.issuer, m.baseMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.issuer, true), m.issuer, m.quoteMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.maker, true), m.maker, m.quoteMint),
      await c.settle({ mandate: key, m: fm ?? m }),
    ], { done: "SLA settled and funds distributed.", mandate: key }).then(after);

  const role = isIssuer ? "issuer" : isMaker ? "maker" : "observer";
  const b = !!busy;

  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Manage</span>
        {me && <span className="tag">{role === "observer" ? <><Eye />Observer</> : role === "issuer" ? "You are the issuer" : "You are the maker"}</span>}
      </div>
      <div className="card-body" style={{ display: "grid", gap: 12 }}>
        {!me && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Connect a wallet to accept this SLA, manage its liquidity or settle it. Checking and settlement are open to everyone.</p>
            <WalletButton />
          </>
        )}
        {me && status === "Open" && isIssuer && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Waiting for a market maker. You can cancel and recover everything until one accepts.</p>
            <button className="btn btn-danger" onClick={cancel} disabled={b}>Cancel offer</button>
          </>
        )}
        {me && status === "Open" && !isIssuer && (openToAll || isMaker) && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Accepting posts a bond of <b style={{ color: "var(--ink)" }}>{fmtFull(Number(t.bondAmount) / 10 ** qd)}</b> and starts a {t.durationPeriods.toLocaleString("en-US")}-period term after a one-minute setup window. You earn {fmtFull(Number(t.feePerPeriod) / 10 ** qd)} per compliant period, and every fee is already in escrow.
            </p>
            {underfunded ? (
              <div className="notice warn small">The fee budget doesn&apos;t cover the whole term yet ({fmtFull(Number(balances[2]) / 10 ** qd)} of {fmtFull(maxFees / 10 ** qd)}), so the program won&apos;t let a maker accept until the issuer tops it up.</div>
            ) : (
              <button className="btn btn-primary" onClick={accept} disabled={b}>Accept and post bond</button>
            )}
          </>
        )}
        {me && status === "Open" && !isIssuer && !openToAll && !isMaker && <p className="small muted" style={{ margin: 0 }}>This offer is reserved for {nameOf(book, m.maker, "a designated maker")}.</p>}
        {me && status === "Active" && isMaker && !hasPosition && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Open the SLA&apos;s DLMM position around the reference price, then place the vault&apos;s inventory in it.</p>
            <button className="btn btn-primary" onClick={openPosition} disabled={b}>Open DLMM position</button>
          </>
        )}
        {me && status === "Active" && isMaker && hasPosition && (
          <>
            <div className="form-grid">
              <label className="field"><span className="field-label">Share of idle inventory</span>
                <span className="input-wrap"><input className="input has-suffix" type="number" min={1} max={100} value={pctDeploy} onChange={(e) => setPctDeploy(Number(e.target.value))} /><span className="input-suffix">%</span></span>
              </label>
              <label className="field"><span className="field-label">Bins each side</span>
                <input className="input" type="number" min={1} max={34} value={halfWidth} onChange={(e) => setHalfWidth(Number(e.target.value))} />
              </label>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={deploy} disabled={b} style={{ flex: 1 }}>Place inventory</button>
              <button className="btn btn-secondary" onClick={() => pull(false)} disabled={b}>Withdraw</button>
            </div>
            <span className="xs muted">Bids go at or below the reference and asks at or above it. Withdrawn liquidity returns to the vault, never to your wallet.</span>
          </>
        )}
        {me && status === "Active" && !isMaker && (
          <p className="small muted" style={{ margin: 0 }}>
            {isIssuer ? "Your inventory is under the maker's management for the term. " : ""}You can check the maker at any time; periods close out on the next check.
          </p>
        )}
        {me && isMaker && earned > 0 && <button className="btn btn-secondary" onClick={claim} disabled={b}>Collect {fmt(earned)} in earned fees</button>}
        {me && status === "Active" && now >= periodEnd && <button className="btn btn-secondary" onClick={finalize} disabled={b}>Close out elapsed periods</button>}
        {me && (status === "Breached" || status === "Expired") && (
          <>
            <p className="small muted" style={{ margin: 0 }}>{status === "Breached" ? "The maker breached the agreement. " : "The term has ended. "}Anyone can unwind the position and pay out the balances.</p>
            {hasPosition
              ? <button className="btn btn-primary" onClick={() => pull(true)} disabled={b}>Unwind liquidity</button>
              : <button className="btn btn-primary" onClick={settle} disabled={b}>Settle and pay out</button>}
          </>
        )}
        {me && (status === "Settled" || status === "Cancelled") && <p className="small muted" style={{ margin: 0 }}>This SLA is closed. Every balance has been paid out.</p>}
        {busy && <span className="xs muted">{busy}: waiting for confirmation…</span>}
      </div>
    </div>
  );
}

/** Who got what when the agreement ended, from the settlement and slash events where available. */
function SettlementReceipt({ v, events, base, quote, bd, qd, book }: { v: MandateView; events: FeedEvent[] | null; base: string; quote: string; bd: number; qd: number; book: PersonaBook }) {
  const { m, status } = v;
  const settled = events?.find((e) => e.name === "mandateSettled");
  const slashed = events?.find((e) => e.name === "makerSlashed");
  const q = (x: any) => Number(x?.toString?.() ?? x) / 10 ** qd;
  const b = (x: any) => Number(x?.toString?.() ?? x) / 10 ** bd;
  const team = nameOf(book, m.issuer, "The team");
  const maker = nameOf(book, m.maker, "The maker");
  const link = (e?: FeedEvent) => (e ? <a className="link xs" href={explorerUrl(e.sig)} target="_blank" rel="noreferrer">transaction</a> : null);
  const rows: [string, React.ReactNode, React.ReactNode][] = [];
  if (Number(m.bondSlashed) > 0) rows.push([`Slashed from ${maker}'s bond to ${team}`, <b key="s" style={{ color: "var(--down)" }}>{fmt(q(m.bondSlashed))} {quote}</b>, link(slashed)]);
  if (settled) {
    const d = settled.data;
    rows.push([`Inventory and unused fees back to ${team}`, <b key="t">{fmt(b(d.toIssuerBase))} {base} + {fmt(q(d.toIssuerQuote))} {quote}</b>, link(settled)]);
    rows.push([`Paid to ${maker} at settlement`, <b key="m">{fmt(q(d.toMakerQuote))} {quote}</b>, <span key="n" className="xs muted">earned fees + remaining bond</span>]);
  } else if (status === "Settled") {
    rows.push([`Fees ${maker} earned over the term`, <b key="f">{fmt(q(m.feesEarned))} {quote}</b>, null]);
  }
  return (
    <div className="card">
      <div className="card-head"><span className="h3">Settlement</span><span className="xs muted">{status === "Settled" ? "Paid out" : "Waiting for anyone to settle"}</span></div>
      <div className="card-body" style={{ display: "grid", gap: 12 }}>
        {rows.length === 0 && <span className="small muted">The maker breached; the position is being unwound before the balances are paid out.</span>}
        {rows.map(([k, val, l]) => (
          <div key={k} style={{ display: "grid", gap: 2 }}>
            <span className="xs muted">{k}</span>
            <span className="row-between" style={{ gap: 8 }}><span className="num">{val}</span>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
