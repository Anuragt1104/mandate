"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FilePen } from "lucide-react";
import type { SharedReport } from "../../../../../sdk/src/report";
import { PRESETS, prefillLink, readHash } from "@/lib/drafts";
import { ExecutionTable, PeriodStrip, ReadinessPanel, ReplaySummary } from "@/components/report";
import { Address, shortAddr } from "@/components/ui";

/** A service report someone shared as a link: read-only, no wallet, nothing stored. */
export default function SharedReportPage() {
  const router = useRouter();
  const [r, setR] = useState<SharedReport | null | undefined>(undefined);
  useEffect(() => {
    const load = () => readHash<SharedReport>("r").then((x) => setR(x && x.kind === "mandate-report" ? x : null));
    load();
    window.addEventListener("hashchange", load);
    return () => window.removeEventListener("hashchange", load);
  }, []);
  if (r === undefined) return null;
  if (!r) {
    return (
      <div className="card empty-state" style={{ marginTop: 20 }}>
        <span className="h3" style={{ color: "var(--ink)" }}>This link doesn&apos;t contain a report</span>
        <span className="small">It may have been cut short when it was copied. Ask for the link again, or start your own observation.</span>
        <Link className="btn btn-secondary btn-sm" href="/app/monitor">Monitor an arrangement</Link>
      </div>
    );
  }
  const quote = r.symbols.quote ?? "quote";
  const title = `${r.symbols.base ?? shortAddr(r.pair, 3)}/${quote}${r.operatorName ? ` · ${r.operatorName}` : ""}`;
  const fmtDate = (t: number) => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  async function draft() {
    const t = r!.suggested?.terms ?? r!.terms;
    router.push(
      await prefillLink({
        market: { cluster: r!.cluster, baseMint: "", quoteMint: "", lbPair: r!.pair, referencePool: "", base: r!.symbols.base, quote: r!.symbols.quote },
        terms: { ...PRESETS[0].terms, periodMinutes: String(Math.max(1, r!.periodSecs / 60)), minDepth: String(t.minDepth), depthWindowBps: String(t.depthWindowBps), maxSpreadBps: String(t.maxSpreadBps) },
        operator: r!.owner ?? undefined,
        evidence: `/app/report${window.location.hash}`,
        basis: r!.suggested ? `Service levels derived from observation. ${r!.suggested.basis}` : "Service levels copied from the terms this report checked.",
        title: `${title} agreement`,
      }),
    );
  }

  return (
    <>
      <Link className="crumb" href="/app/reports"><ArrowLeft />Reports</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Service report · {r.cluster} · observed, not self-reported</span>
          <h1 className="h1">{title}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Pair <Address value={r.pair} /> · operator {r.owner ? <Address value={r.owner} /> : "unknown"} · {fmtDate(r.startedAt)} to {fmtDate(r.endedAt)} · {r.summary.samples} samples
          </p>
        </div>
        <button className="btn btn-primary" onClick={draft}><FilePen />Draft the next agreement from this</button>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Periods</span><span className="xs muted">{r.periodSecs / 60}-minute periods</span></div>
            <div className="card-body"><PeriodStrip codes={r.periods} periodSecs={r.periodSecs} startedAt={r.startedAt} cells={120} /></div>
          </div>
          <div className="card">
            <div className="card-head"><span className="h3">Against the terms checked</span></div>
            <div className="card-body"><ReplaySummary s={r.summary} failures={r.failures} observed={r.observed} terms={r.terms} quote={quote} unobserved={r.summary.unobserved} /></div>
          </div>
          <div className="card">
            <div className="card-head"><span className="h3">What traders could execute</span><span className="xs muted">Not part of any agreement</span></div>
            <div className="card-body"><ExecutionTable rows={r.execution} quote={quote} /></div>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">How much to read into it</span></div>
            <div className="card-body"><ReadinessPanel r={r.readiness} /></div>
          </div>
          {r.suggested && (
            <div className="card card-pad" style={{ display: "grid", gap: 8 }}>
              <span className="h3">Terms this operator delivered</span>
              <span className="small" style={{ color: "var(--ink-2)" }}>
                At least <b>{r.suggested.terms.minDepth.toLocaleString("en-US")} {quote}</b> each side within {r.suggested.terms.depthWindowBps} bps, spread ≤ <b>{r.suggested.terms.maxSpreadBps} bps</b>.
              </span>
              <span className="xs muted">{r.suggested.basis} A starting point for negotiation, not a recommendation.</span>
            </div>
          )}
          <div className="card card-pad" style={{ display: "grid", gap: 6 }}>
            <span className="h3">How this was measured</span>
            <span className="xs muted">
              The operator&apos;s Meteora DLMM positions were read at random times. Each bin was valued at its own price with the Mandate program&apos;s arithmetic, so trades against the book don&apos;t change the result. The reference is the pair&apos;s own oracle TWAP. Samples that couldn&apos;t be measured are counted as incomplete, never as misses.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
