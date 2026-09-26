"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Download, ExternalLink } from "lucide-react";
import { collectEvidence, verifyEvidence, STATUS_WORD, type EvidenceBundle, type VerifyResult } from "../../../../../../../../sdk/src/evidence";
import { approvalState, draftToChain, type DraftDoc } from "../../../../../../../../sdk/src/draft";
import { CLUSTER, connection, explorerUrl, readClient } from "@/lib/chain";
import { loadMandate, type MandateView } from "@/lib/loaders";
import { listDrafts } from "@/lib/local";
import { copyText, docFromLink } from "@/lib/drafts";
import { usePersonas } from "@/lib/personas";
import { nameOf } from "@/components/sla";
import { Skeleton, fmt, fmtFull, shortAddr } from "@/components/ui";

/**
 * Why was this operator paid (or not) for one period: the agreed terms, what was measured, the
 * rule, the outcome and the settlement, each with its on-chain source, recomputed in the
 * browser from a downloadable evidence bundle that scripts/explain.ts can check independently.
 */
export default function PeriodPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = use(params);
  const period = Number(n) - 1;
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(id);
  } catch {
    /* invalid */
  }
  const [v, setV] = useState<MandateView | null>(null);
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [progress, setProgress] = useState("Reading the agreement…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !Number.isInteger(period) || period < 0) return;
    let live = true;
    setBundle(null);
    setError(null);
    (async () => {
      try {
        const view = await loadMandate(key);
        if (!live) return;
        if (!view) throw new Error("agreement not found");
        setV(view);
        const b = await collectEvidence(connection(), readClient(), key, period, {
          cluster: CLUSTER,
          source: "Mandate's RPC proxy",
          quoteDecimals: view.mints.quote.decimals,
          onProgress: (t) => live && setProgress(t),
        });
        if (live) setBundle(b);
      } catch (e) {
        if (live) setError((e as Error).message?.split("\n")[0] ?? String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [id, period]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!key || !Number.isInteger(period) || period < 0) return <div className="notice warn">That isn&apos;t an agreement period.</div>;
  const back = <Link className="crumb" href={`/app/mandate/${id}`}><ArrowLeft />Agreement</Link>;
  if (error) return <>{back}<div className="notice warn">Couldn&apos;t gather the evidence: {error}</div></>;
  if (!v || !bundle) {
    return (
      <>
        {back}
        <div className="page-head"><div><span className="eyebrow">Why was this paid? · period {period + 1}</span><h1 className="h1">Gathering the evidence</h1><p className="muted small" style={{ margin: 0 }}>{progress}</p></div></div>
        <div className="stack"><Skeleton h={120} /><Skeleton h={220} /><Skeleton h={160} /></div>
      </>
    );
  }
  return <Explained v={v} b={bundle} />;
}

function Explained({ v, b }: { v: MandateView; b: EvidenceBundle }) {
  const book = usePersonas();
  const t = b.terms;
  const qd = v.mints.quote.decimals;
  const quote = v.labels[v.m.quoteMint.toBase58()]?.symbol ?? "quote";
  // Money here is exact (this is what an invoice would cite); measurements below are rounded.
  const Q = (a: string | bigint) => `${fmtFull(Number(a) / 10 ** qd, Math.min(qd, 6))} ${quote}`;
  const { explanation: x, results, ok } = useMemo(() => verifyEvidence(b, Q), [b, qd, quote]); // eslint-disable-line react-hooks/exhaustive-deps
  const maker = nameOf(book, v.m.maker, "the operator");
  const team = nameOf(book, v.m.issuer, "the team");
  const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "time unknown");
  const recorded = b.finalized?.status ?? null;
  const status = recorded ?? x.status;
  const tone = status === 1 ? "up" : status === 2 ? "down" : "ended";
  const [note, setNote] = useState<string | null>(null);

  const failing = x.verdicts.filter((c) => !c.ok);
  const what = (c: (typeof x.verdicts)[number]) =>
    [!c.bids && `bids ${Q(c.check.bidDepthQuote)} against a ${Q(t.minDepthQuote)} minimum`, !c.asks && `asks ${Q(c.check.askDepthQuote)} against a ${Q(t.minDepthQuote)} minimum`, !c.spread && (c.check.spreadBps === 65535 ? "one side of the book empty" : `spread ${c.check.spreadBps} bps against a ${t.maxSpreadBps} bps limit`)].filter(Boolean).join(", ");

  const headline =
    status === 1 ? `Met: ${maker} earned ${Q(t.feePerPeriod)}`
    : status === 2 ? (x.breach?.reached ? `Failed: no fee, and ${maker}'s bond was slashed` : `Failed: no fee for ${maker}`)
    : status === 3 ? "Not checked: neither paid nor failed"
    : "Undetermined from the evidence found";

  function download() {
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mandate-evidence-${b.mandate.slice(0, 8)}-p${b.period + 1}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const cmd = `npx tsx scripts/explain.ts --bundle mandate-evidence-${b.mandate.slice(0, 8)}-p${b.period + 1}.json --recheck --rpc <your RPC>`;
  const indep = `npx tsx scripts/explain.ts --cluster ${b.cluster} --mandate ${b.mandate} --period ${b.period + 1} --decimals ${qd}`;
  const tx = (sig: string, label = shortAddr(sig, 6)) => <a className="link mono xs row" style={{ gap: 3, display: "inline-flex" }} href={explorerUrl(sig)} target="_blank" rel="noreferrer">{label}<ExternalLink style={{ width: 11 }} /></a>;
  const mark = (pass: boolean) => <span className={pass ? "pass" : "fail"} aria-label={pass ? "passed" : "failed"}>{pass ? "✓" : "✗"}</span>;
  const last = t.durationPeriods;

  return (
    <>
      <div className="row-between" style={{ marginBottom: 16 }}>
        <Link className="crumb" style={{ margin: 0 }} href={`/app/mandate/${b.mandate}`}><ArrowLeft />Agreement</Link>
        <div className="row" style={{ gap: 6 }}>
          {b.period > 0 && <Link className="btn btn-ghost btn-sm" href={`/app/mandate/${b.mandate}/period/${b.period}`}><ChevronLeft />Period {b.period}</Link>}
          {b.period + 1 < Math.min(last, Number(v.m.currentPeriod)) && <Link className="btn btn-ghost btn-sm" href={`/app/mandate/${b.mandate}/period/${b.period + 2}`}>Period {b.period + 2}<ChevronRight /></Link>}
        </div>
      </div>
      <div className="page-head">
        <div>
          <span className="eyebrow">Why was this paid? · period {b.period + 1} of {last} · {b.cluster}</span>
          <h1 className="h1">{headline}</h1>
          <p className="muted small" style={{ margin: 0 }}>{when(x.window.from)} to {when(x.window.to)} · {maker} for {team}</p>
        </div>
        <span className={`chip ${tone}`}><span className="dot" />{status ? STATUS_WORD[status] : "undetermined"}</span>
      </div>

      <div className="grid-main">
        <ol className="chain">
          <li>
            <span className="step">1</span>
            <div className="card">
              <div className="card-head"><span className="h3">What was agreed</span><span className="xs muted">fixed at creation; the program can&apos;t change them</span></div>
              <div className="card-body" style={{ display: "grid", gap: 6 }}>
                <span className="small">Each side: at least <b>{Q(t.minDepthQuote)}</b> committed within {t.depthWindowBps} bps of the reference price. Spread at most <b>{t.maxSpreadBps} bps</b>.</span>
                <span className="small">Fee <b>{Q(t.feePerPeriod)}</b> for every period that meets this. {t.maxConsecutiveFailures} failed periods in a row slash {t.slashBps / 100}% of the {Q(t.bondAmount)} bond to the team.</span>
                <DraftMatch mandate={b.mandate} v={v} />
              </div>
            </div>
          </li>

          <li>
            <span className={`step ${x.verdicts.length ? (failing.length ? "down" : "up") : ""}`}>2</span>
            <div className="card">
              <div className="card-head">
                <span className="h3">What was measured</span>
                <span className="xs muted">{x.recordedChecks === null ? `${x.verdicts.length} checks found` : x.complete ? `all ${x.recordedChecks} recorded check${x.recordedChecks === 1 ? "" : "s"} found` : `${x.verdicts.length} of ${x.recordedChecks} recorded checks found`}</span>
              </div>
              {x.verdicts.length ? (
                <div className="checks">
                  {x.verdicts.map((c) => (
                    <div className="check-row" key={c.check.sig}>
                      <div className="row-between" style={{ gap: 8 }}>
                        <span className="xs"><b className={c.ok ? "pass" : "fail"}>{c.ok ? "Pass" : "Fail"}</b> · {c.check.blockTime ? new Date(c.check.blockTime * 1000).toLocaleTimeString() : "time unknown"} · by {nameOf(book, new PublicKey(c.check.cranker), shortAddr(c.check.cranker, 4))}</span>
                        {tx(c.check.sig)}
                      </div>
                      <div className="conds">
                        <span className={`cond ${c.bids ? "ok" : "bad"}`}>{mark(c.bids)} Bids <b className="num">{fmt(Number(c.check.bidDepthQuote) / 10 ** qd)}</b> <span className="muted">/ {fmt(Number(t.minDepthQuote) / 10 ** qd)} min</span></span>
                        <span className={`cond ${c.asks ? "ok" : "bad"}`}>{mark(c.asks)} Asks <b className="num">{fmt(Number(c.check.askDepthQuote) / 10 ** qd)}</b> <span className="muted">/ {fmt(Number(t.minDepthQuote) / 10 ** qd)} min</span></span>
                        <span className={`cond ${c.spread ? "ok" : "bad"}`}>{mark(c.spread)} Spread <b className="num">{c.check.spreadBps === 65535 ? "empty side" : `${c.check.spreadBps} bps`}</b> <span className="muted">/ {t.maxSpreadBps} max</span></span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="card-body small muted">{x.recordedChecks === 0 ? "Nobody took a check during this period." : "No checks of this period were found in the agreement's history."}</div>
              )}
              <div className="card-foot xs muted">
                Each check is a transaction in which the Mandate program measured {maker}&apos;s committed liquidity in {quote}, bin by bin, around the reference price. Anyone can take one at any time, so the operator can&apos;t know when to be ready.
              </div>
            </div>
          </li>

          <li>
            <span className="step">3</span>
            <div className="card">
              <div className="card-head"><span className="h3">The rule</span></div>
              <div className="card-body" style={{ display: "grid", gap: 6 }}>
                <span className="small">A period is paid only if it was checked at least once and <b>every</b> check passed all three conditions.</span>
                <span className="small">{x.statusReason}{failing.length ? ` ${failing.length === 1 ? "The failing check had" : new Set(failing.map(what)).size === 1 ? `All ${failing.length} failing checks had` : "The first failing check had"} ${what(failing[0])}.` : ""}</span>
              </div>
            </div>
          </li>

          <li>
            <span className={`step ${tone}`}>4</span>
            <div className="card">
              <div className="card-head"><span className="h3">The outcome</span>{b.finalized && <span className="xs muted row" style={{ gap: 6 }}>recorded {when(b.finalized.blockTime)} {tx(b.finalized.sig)}</span>}</div>
              <div className="card-body" style={{ display: "grid", gap: 6 }}>
                {status === 1 && <span className="small">Met, so the fee accrues: <b>{Q(t.feePerPeriod)}</b> to {maker}{b.finalized ? `; the program accrued ${Q(b.finalized.feeAccrued)}` : ""}.</span>}
                {status === 3 && <span className="small">Unchecked periods earn nothing and don&apos;t count toward a breach.</span>}
                {status === 2 && (
                  <>
                    <span className="small">Failed, so no fee. {x.consecutiveFailed !== null && <>This was failed period <b>{x.consecutiveFailed}{x.consecutiveKnown ? "" : "+"}</b> in a row; the limit is {t.maxConsecutiveFailures}.</>}</span>
                    {x.breach?.reached && <span className="small">The limit was reached: {t.slashBps / 100}% × {Q(t.bondAmount)} bond = <b>{Q(x.breach.slash)}</b> to {team}{b.slash ? <>, slashed in {tx(b.slash.sig)}</> : ""}. The agreement ended as breached.</span>}
                  </>
                )}
                {status === null && <span className="small">The evidence found isn&apos;t enough to decide; see the notes below.</span>}
              </div>
            </div>
          </li>

          <li>
            <span className="step">5</span>
            <div className="card">
              <div className="card-head"><span className="h3">Settlement</span></div>
              <div className="card-body small">
                {status !== 1 ? "Nothing was owed for this period." : b.payout ? (
                  <>Paid {b.payout.first ? "in" : "no later than"} a {b.payout.kind === "claim" ? "fee claim" : "final settlement"} of {Q(b.payout.amount)} (every fee owed at that point) on {when(b.payout.blockTime)}: {tx(b.payout.sig)}</>
                ) : "Accrued and still owed to the operator: it's paid out by the next fee claim or at settlement."}
              </div>
            </div>
          </li>
        </ol>

        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Check it yourself</span><span className={`chip ${ok ? "up" : "down"}`}><span className="dot" />{ok ? "consistent" : "mismatch"}</span></div>
            <div className="card-body" style={{ display: "grid", gap: 8 }}>
              {results.map((r) => <ResultRow key={r.name} r={r} />)}
            </div>
            <div className="card-foot" style={{ display: "grid", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={download}><Download />Download evidence</button>
              <span className="xs muted">In a clone of <a className="link" href="https://github.com/Anuragt1104/mandate" target="_blank" rel="noreferrer">the Mandate repository</a>, recompute it offline and re-fetch every cited transaction from an RPC you choose:</span>
              <code className="xs mono" style={{ wordBreak: "break-all" }}>{cmd}</code>
              <span className="xs muted">Or collect it without this site at all:</span>
              <code className="xs mono" style={{ wordBreak: "break-all" }}>{indep}</code>
              <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={async () => setNote((await copyText(indep)) ? "Command copied." : "Copy it from above.")}><Copy />Copy command</button>
              {note && <span className="xs muted">{note}</span>}
            </div>
          </div>
          <div className="card card-pad" style={{ display: "grid", gap: 8 }}>
            <span className="h3">What this proves</span>
            <span className="small"><b>Recomputed:</b> each check&apos;s verdict from its measurements, the period&apos;s status, the fee and any slash, here and by the command-line verifier.</span>
            <span className="small"><b>On chain, not recomputed:</b> the measurements themselves. The program took them from the pool inside each transaction; the pool&apos;s past state isn&apos;t available to re-measure.</span>
            <span className="small"><b>Trusted:</b> the RPC that served the transactions (here, {b.source}). Re-fetching from another RPC checks it; a hash of one RPC&apos;s answer wouldn&apos;t.</span>
            {b.search.note && <div className="notice warn xs">{b.search.note}</div>}
            <span className="xs muted">Listed {b.search.signaturesScanned} of the agreement&apos;s transactions and read {b.search.transactionsRead} in full.</span>
          </div>
        </div>
      </div>
    </>
  );
}

function ResultRow({ r }: { r: VerifyResult }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 6 }}>
      <span className={r.pass === null ? "muted" : r.pass ? "pass" : "fail"}>{r.pass === null ? "?" : r.pass ? "✓" : "✗"}</span>
      <span className="xs"><b>{r.name}</b> <span className="muted">· {r.basis}</span><br /><span className="muted">{r.detail}</span></span>
    </div>
  );
}

/** If a signed draft in this browser or workspace was posted as this agreement, show whether the chain's terms match it. */
function DraftMatch({ mandate, v }: { mandate: string; v: MandateView }) {
  const [text, setText] = useState<{ ok: boolean; line: string } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      for (const d of listDrafts()) {
        const doc: DraftDoc | null = await docFromLink(d.link);
        if (!doc?.posted || doc.posted.mandate !== mandate) continue;
        const st = await approvalState(doc);
        const want = draftToChain(st.latest.terms, v.mints.base.decimals, v.mints.quote.decimals).terms as Record<string, bigint | number>;
        const have = v.m.terms as Record<string, any>;
        const differ = Object.keys(want).filter((k) => String(want[k]) !== String(have[k]?.toString?.() ?? have[k]));
        if (live) setText({ ok: st.agreed && !differ.length, line: `Posted from the draft "${d.title}", version ${st.latest.n}${st.agreed ? ", approved by both parties" : " (not approved by both)"}. ${differ.length ? `These terms differ from it: ${differ.join(", ")}.` : "The agreement's terms match it exactly."}` });
        return;
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [mandate, v]);
  return text ? <span className={`xs ${text.ok ? "" : "fail"}`}>{text.line}</span> : null;
}
