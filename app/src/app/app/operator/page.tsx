"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { CircleAlert, FlaskConical, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { statusName } from "../../../../../sdk/src";
import { DIAGNOSIS_LABELS } from "../../../../../sdk/src/sentinel";
import { usePoll, useNow } from "@/lib/hooks";
import { loadBoard, loadMandate, type MandateView } from "@/lib/loaders";
import { loadFeed, type FeedEvent } from "@/lib/feed";
import { readClient } from "@/lib/chain";
import { latestRead, trustedWatchtowers, type ShownRead } from "@/lib/trust";
import { buildAction, simulate, type ActionKind, type ProposedAction, type Simulation } from "@/lib/maker";
import { useMandateActions } from "@/lib/actions";
import { usePersonas, type PersonaBook } from "@/lib/personas";
import { judgeName, nameOf } from "@/components/sla";
import { Skeleton, ago, countdown, fmt, shortAddr } from "@/components/ui";

export default function OperatorPage() {
  return (
    <Suspense fallback={null}>
      <Queue />
    </Suspense>
  );
}

interface Item {
  v: MandateView;
  events: FeedEvent[];
  read: ShownRead | null;
  severity: number;
  headline: string;
  evidence: string[];
  action: ProposedAction | null;
  blocked?: string;
}

/** Feedback on alerts, kept locally, to measure whether prioritisation helps. */
const FEEDBACK = "mandate.alertFeedback.v1";
type Feedback = { id: string; mandate: string; diagnosis: string; raisedAt: number; early: boolean; verdict: "useful" | "not-useful" | "dismissed"; at: number };
const readFeedback = (): Feedback[] => {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK) ?? "[]");
  } catch {
    return [];
  }
};

function assess(v: MandateView, events: FeedEvent[], read: ShownRead | null, now: number, quote: string): Item {
  const { m, status } = v;
  const t = m.terms;
  const qd = v.mints.quote.decimals;
  const Q = (x: any) => Number(x?.toString?.() ?? x) / 10 ** qd;
  const minDepth = Q(t.minDepthQuote);
  const period = t.periodSecs as number;
  const evidence: string[] = [];
  const book = v.book;
  const hasPos = !(m.position as PublicKey).equals(PublicKey.default);
  const owed = Q(m.feesEarned) - Q(m.feesClaimed);

  if (status === "Open") return { v, events, read, severity: 2, headline: "Offered to you: review and accept", evidence: [`${fmt(Q(t.feePerPeriod))} ${quote} per compliant ${period / 60}-minute period for ${t.durationPeriods} periods; ${fmt(Q(t.bondAmount))} ${quote} bond.`], action: { kind: "accept", title: "Accept and post the bond", why: "The fee budget is escrowed; scoring starts one minute after you accept." } };
  if (status === "Breached" || status === "Expired") {
    return { v, events, read, severity: 1, headline: status === "Breached" ? "Breached: unwind and settle" : "Term complete: unwind and settle", evidence: [owed > 0 ? `${fmt(owed)} ${quote} of earned fees still to collect.` : "Nothing left to collect."], action: hasPos ? { kind: "unwind", title: "Unwind the position", why: "Returns the inventory to the vaults so the agreement can settle." } : { kind: "settle", title: "Settle and pay out", why: "Sends inventory and unused fees to the team, and your earned fees and remaining bond to you." } };
  }

  // Active: what changed since the last passing check, from the program's own events.
  const checks = events.filter((e) => e.name === "snapshotTaken");
  const latest = checks[0];
  const lastPass = checks.find((e) => e.data.ok);
  if (latest && lastPass && latest !== lastPass) {
    const d0 = lastPass.data;
    const d1 = latest.data;
    const moved = Number(d1.anchorBin) - Number(d0.anchorBin);
    evidence.push(`Since the last passing check (${ago(Math.max(0, now - lastPass.ts))}): bids ${fmt(Q(d0.bidDepthQuote), 0)} → ${fmt(Q(d1.bidDepthQuote), 0)}, asks ${fmt(Q(d0.askDepthQuote), 0)} → ${fmt(Q(d1.askDepthQuote), 0)} ${quote}; the reference moved ${moved === 0 ? "0 bins" : `${moved > 0 ? "up" : "down"} ${Math.abs(moved)} bin${Math.abs(moved) === 1 ? "" : "s"}`}.`);
    const actions = events.filter((e) => e.ts > lastPass.ts && (e.name === "liquidityWithdrawn" || e.name === "liquidityDeployed"));
    if (actions.length) evidence.push(`Your actions since: ${actions.map((e) => (e.name === "liquidityDeployed" ? "placed liquidity" : "withdrew liquidity")).join(", ")}.`);
  }
  const failingNow = m.snapshotsTotal > 0 && !m.last.ok;
  const predicted = book?.committed.status === "measured" ? book.committed : null;
  const [baseIdle, quoteIdle] = v.balances;
  const baseIdleValue = book ? (Number(baseIdle) / 10 ** v.mints.base.decimals) * book.refUi : 0;
  const quoteIdleValue = Q(quoteIdle);
  let severity = 0;
  let headline = "Quoting normally";
  let action: ProposedAction | null = null;
  let blocked: string | undefined;
  if (failingNow) {
    severity = 3;
    headline = `Last check failed · ${m.consecutiveFailed} failed period${m.consecutiveFailed === 1 ? "" : "s"} in a row of ${t.maxConsecutiveFailures}`;
  } else if (predicted && !predicted.ok) {
    severity = 2;
    headline = "The next check would fail at the current reference";
  }
  if (predicted) evidence.push(`At the reference now: bids ${fmt(Number(predicted.bidDepth) / 10 ** qd, 0)}, asks ${fmt(Number(predicted.askDepth) / 10 ** qd, 0)} ${quote} (minimum ${fmt(minDepth, 0)}), spread ${predicted.spreadBps === 65535 ? "not measurable" : `${predicted.spreadBps} bps`}.`);

  if (!hasPos) {
    action = { kind: "open", title: "Open a position around the reference", why: "No position is open, so every check fails." };
    severity = Math.max(severity, 3);
  } else if (book) {
    const lower = m.positionLowerBinId as number;
    const upper = lower + (m.positionWidth as number) - 1;
    const room = Math.min(book.refBin - lower, upper - book.refBin);
    if (room < 12) {
      action = { kind: "recentre", title: "Re-centre: withdraw and reopen around the reference", why: room < 0 ? "The reference has left your position's range." : `The reference is ${room} bins from the edge of your position.` };
      severity = Math.max(severity, room < 0 ? 3 : 1);
    } else if (quoteIdleValue > minDepth / 10 || baseIdleValue > minDepth / 10) {
      action = { kind: "deploy", title: "Place idle inventory", why: `${fmt(quoteIdleValue, 0)} ${quote} and ${fmt(baseIdleValue, 0)} ${quote} worth of tokens are idle in the vault.` };
    }
    // The failure the vault can't fix: the committed side is short and there's no inventory left for it.
    if (predicted && predicted.askDepth < BigInt(Math.round(minDepth * 10 ** qd)) && baseIdleValue < minDepth / 10) blocked = "The ask side is short and the vault holds almost no tokens to quote. The vault can't buy tokens back; ask the team to add token inventory, or propose different terms.";
    if (predicted && predicted.bidDepth < BigInt(Math.round(minDepth * 10 ** qd)) && quoteIdleValue < minDepth / 10) blocked = "The bid side is short and the vault holds almost no quote. Ask the team to add quote inventory, or propose different terms.";
  }
  if (!action && Math.floor((now - m.startTs.toNumber()) / period) > (m.currentPeriod as number)) action = { kind: "finalize", title: "Close out elapsed periods", why: "Books the fees for the periods that have ended." };
  if (!action && owed >= Q(t.feePerPeriod) * 10) action = { kind: "claim", title: `Collect ${fmt(owed)} ${quote} of earned fees`, why: "Fees earned for compliant periods." };
  const left = m.endTs.toNumber() - now;
  if (left > 0 && left < 0.1 * t.durationPeriods * period) evidence.push(`Term ends in ${countdown(left)}: see the renewal report.`);
  if (read && read.standing === "trusted" && read.v.read.diagnosis !== "quoting_normally") severity = Math.max(severity, 1);
  return { v, events, read, severity, headline, evidence, action, blocked };
}

function Queue() {
  const router = useRouter();
  const params = useSearchParams();
  const book = usePersonas();
  const { publicKey } = useWallet();
  const now = useNow(15_000);
  const viewAs = params.get("as");
  const operator = viewAs ?? publicKey?.toBase58() ?? null;
  const trusted = useMemo(() => trustedWatchtowers(book), [book]);
  const { data: loaded, error } = usePoll(async () => {
    if (!operator) return { items: [] as Item[], failed: 0 };
    const board = await loadBoard();
    const mine = board.rows.filter((r) => r.m.maker.toBase58() === operator && ["Open", "Active", "Breached", "Expired"].includes(r.status));
    const out: Item[] = [];
    let failed = 0;
    // One agreement at a time and a short event window each: the queue must stay light on RPC.
    for (const r of mine) {
      try {
        const v = await loadMandate(r.pubkey);
        if (!v) continue;
        const events = await loadFeed(r.pubkey, 12).catch(() => [] as FeedEvent[]);
        const quote = v.labels[v.m.quoteMint.toBase58()]?.symbol ?? "quote";
        out.push(assess(v, events, latestRead(events, r.pubkey.toBase58(), trusted, Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000), quote));
      } catch {
        failed++; // retried on the next poll
      }
    }
    // The watchtower's read decides the order among equals: its breach outlook is the tie-breaker.
    const outlook = (i: Item) => (i.read?.standing === "trusted" && Number.isFinite(i.read.v.read.breach) ? i.read.v.read.breach : 0);
    return { items: out.sort((a, b) => b.severity - a.severity || outlook(b) - outlook(a)), failed };
  }, [operator, trusted.size], 20_000);
  const items = loaded?.items ?? null;
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  useEffect(() => setFeedback(readFeedback()), []);
  const makers = Object.entries(book.parties).filter(([, p]) => p.role === "maker");

  function give(i: Item, verdict: Feedback["verdict"]) {
    const r = i.read!.v.read;
    const f: Feedback = { id: `${i.v.key.toBase58()}:${r.observedTs}`, mandate: i.v.key.toBase58(), diagnosis: r.diagnosis, raisedAt: r.assessedAt, early: !!i.events.find((e) => e.name === "snapshotTaken" && e.ts === r.observedTs)?.data.ok, verdict, at: Math.floor(Date.now() / 1000) };
    const next = [f, ...feedback.filter((x) => x.id !== f.id)].slice(0, 500);
    setFeedback(next);
    try {
      localStorage.setItem(FEEDBACK, JSON.stringify(next));
    } catch {
      /* not stored */
    }
  }
  const stats = { useful: feedback.filter((f) => f.verdict === "useful").length, notUseful: feedback.filter((f) => f.verdict === "not-useful").length, dismissed: feedback.filter((f) => f.verdict === "dismissed").length, early: feedback.filter((f) => f.early && f.verdict === "useful").length };

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">For operators</span>
          <h1 className="h1">Work queue</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "68ch" }}>
            Your agreements, most urgent first: what needs attention, what changed since the last passing check, and a proposed action you can simulate before approving it in your wallet.
          </p>
        </div>
      </div>
      {!operator && (
        <div className="card card-pad" style={{ display: "grid", gap: 10 }}>
          <span className="small">Connect the wallet you operate with, or look at the test network&apos;s operators (read-only):</span>
          <div className="row wrap" style={{ gap: 8 }}>{makers.map(([k, p]) => <button key={k} className="btn btn-secondary btn-sm" onClick={() => router.push(`/app/operator?as=${k}`)}>{p.name}</button>)}</div>
        </div>
      )}
      {operator && (
        <>
          <div className="row wrap small muted" style={{ gap: 12, marginBottom: 12 }}>
            <span>{viewAs ? <>Viewing as <b style={{ color: "var(--ink)" }}>{nameOf(book, operator, shortAddr(operator, 4))}</b> (read-only)</> : <>Your wallet {shortAddr(operator, 4)}</>}</span>
            {feedback.length > 0 && <span>Alert feedback: {stats.useful} useful ({stats.early} raised while checks still passed), {stats.notUseful} not useful, {stats.dismissed} dismissed.</span>}
          </div>
          {!items && !error && <div className="stack"><Skeleton h={120} /><Skeleton h={120} /></div>}
          {error && <div className="notice warn small">{error}</div>}
          {loaded && loaded.failed > 0 && <div className="notice warn small" style={{ marginBottom: 12 }}>Couldn&apos;t load {loaded.failed} of this wallet&apos;s agreements (the RPC is busy); retrying.</div>}
          {items && items.length === 0 && !loaded?.failed && <div className="card empty-state"><span className="small">No agreements for this wallet. Drafts sent to you appear here once the team posts them.</span></div>}
          <div className="stack">{items?.map((i) => <QueueItem key={i.v.key.toBase58()} i={i} book={book} operator={operator} viewAs={!!viewAs} onFeedback={give} given={feedback.find((f) => i.read && f.id === `${i.v.key.toBase58()}:${i.read.v.read.observedTs}`)?.verdict} now={now} />)}</div>
        </>
      )}
    </>
  );
}

function QueueItem({ i, book, operator, viewAs, onFeedback, given, now }: { i: Item; book: PersonaBook; operator: string; viewAs: boolean; onFeedback: (i: Item, v: Feedback["verdict"]) => void; given?: string; now: number }) {
  const { run, busy, me } = useMandateActions();
  const [sim, setSim] = useState<Simulation | null>(null);
  const [simErr, setSimErr] = useState<string | null>(null);
  const { v, read } = i;
  const base = v.labels[v.m.baseMint.toBase58()]?.symbol ?? "token";
  const quote = v.labels[v.m.quoteMint.toBase58()]?.symbol ?? "quote";
  const tone = i.severity >= 3 ? "var(--down)" : i.severity === 2 ? "var(--warn)" : "var(--muted)";
  const r = read?.standing === "trusted" ? read.v.read : null;
  const canAct = !viewAs && me?.toBase58() === operator;

  async function trySim(kind: ActionKind) {
    setSim(null);
    setSimErr(null);
    try {
      const ixs = await buildAction(readClient(), new PublicKey(operator), v, kind);
      setSim(await simulate(new PublicKey(operator), ixs));
    } catch (e: any) {
      setSimErr(e?.message?.split("\n")[0] ?? String(e));
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span className="h3 row" style={{ gap: 8 }}><i style={{ width: 8, height: 8, borderRadius: 4, background: tone, display: "inline-block" }} /><Link className="link" href={`/app/mandate/${v.key.toBase58()}`}>{base}/{quote}</Link> · {i.headline}</span>
        <span className="xs muted">{statusName(v.m.status)} · issued by {nameOf(book, v.m.issuer, "the team")}</span>
      </div>
      <div className="card-body" style={{ display: "grid", gap: 10 }}>
        {r && (
          <div className="notice subtle small" style={{ display: "grid", gap: 6 }}>
            <span>
              Watchtower read ({judgeName(r.source)}, check {ago(Math.max(0, now - r.observedTs))}): <b>{DIAGNOSIS_LABELS[r.diagnosis]}</b>
              {Number.isFinite(r.breach) && r.source !== "rules" && <> · breach outlook {Math.round(r.breach * 100)}%</>}
              {Number.isFinite(r.noRedeploy) && <> · no redeploy within two periods {Math.round(r.noRedeploy * 100)}%</>}
            </span>
            {r.diagnosis !== "quoting_normally" && (
              <span className="row" style={{ gap: 6 }}>
                <span className="xs muted">Was this alert useful?</span>
                <button className="btn btn-ghost btn-sm" aria-pressed={given === "useful"} onClick={() => onFeedback(i, "useful")}><ThumbsUp />Useful</button>
                <button className="btn btn-ghost btn-sm" aria-pressed={given === "not-useful"} onClick={() => onFeedback(i, "not-useful")}><ThumbsDown />Not useful</button>
                <button className="btn btn-ghost btn-sm" aria-pressed={given === "dismissed"} onClick={() => onFeedback(i, "dismissed")}><X />Dismiss</button>
              </span>
            )}
          </div>
        )}
        {i.evidence.map((e) => <span key={e} className="small" style={{ color: "var(--ink-2)" }}>{e}</span>)}
        {i.blocked && <div className="notice warn small"><CircleAlert />{i.blocked}</div>}
        {i.action && (
          <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <span className="small"><b>Proposed: {i.action.title}.</b> <span className="muted">{i.action.why}</span></span>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => trySim(i.action!.kind)}><FlaskConical />Simulate</button>
              {canAct ? (
                <button className="btn btn-primary btn-sm" disabled={!!busy || !sim?.ok} title={!sim?.ok ? "Simulate first" : undefined}
                  onClick={() => run(i.action!.title, async (c, me, fm) => buildAction(c, me, v, i.action!.kind, fm ?? v.m), { mandate: v.key, done: `${i.action!.title}: done.` })}>
                  <Send />Approve and send
                </button>
              ) : <span className="xs muted">{viewAs ? "Read-only view: connect the operator's wallet to act." : "Connect the operator's wallet to act."}</span>}
            </div>
            {sim && <span className="xs" style={{ color: sim.ok ? "var(--up)" : "var(--down)" }}>{sim.ok ? `Simulation succeeded${sim.units ? ` (${sim.units.toLocaleString("en-US")} compute units)` : ""}. Approving asks your wallet to sign exactly this.` : `Simulation failed: ${sim.error}`}</span>}
            {simErr && <span className="xs" style={{ color: "var(--down)" }}>Couldn&apos;t build it: {simErr}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
