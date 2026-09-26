"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { ArrowLeft, Download, FilePen, Pause, Play, Search, Share2, Trash2 } from "lucide-react";
import { DLMM_PROGRAM, findOperators, newSession, resolvePosition, type Operator, type Session } from "../../../../../sdk/src/observe";
import { evaluate, packLink, shareable, suggestTerms, type EvalTerms } from "../../../../../sdk/src/report";
import { CLUSTER, connectionFor, fetchTokenLabels, knownSymbol, type ReadCluster } from "@/lib/chain";
import { deleteSession, loadSession, saveSession } from "@/lib/local";
import { useObserver } from "@/lib/observer";
import { PRESETS, copyText, prefillLink } from "@/lib/drafts";
import { usePersonas, type PersonaBook } from "@/lib/personas";
import { useNow } from "@/lib/hooks";
import { ExecutionTable, PeriodStrip, ReadinessPanel, ReplaySummary } from "@/components/report";
import { Address, InfoTip, ago, countdown, shortAddr } from "@/components/ui";

export default function MonitorPage() {
  return (
    <Suspense fallback={null}>
      <Monitor />
    </Suspense>
  );
}

function Monitor() {
  const id = useSearchParams().get("s");
  return id ? <Observing id={id} /> : <Setup />;
}

const DEFAULT_TERMS: EvalTerms = { minDepth: 500, depthWindowBps: 200, maxSpreadBps: 100 };

/** Names for addresses the test network's persona book knows (agreement vaults, makers). */
function knownName(book: PersonaBook, owner: string): string | null {
  const p = book.parties[owner];
  if (p) return p.name;
  const mandate = Object.entries(book.mandates).find(([, a]) => a === owner)?.[0];
  return mandate ? `${mandate.replace(/\d+$/, "").toUpperCase()} agreement vault (simulated)` : null;
}

function Setup() {
  const router = useRouter();
  const book = usePersonas();
  const [cluster, setCluster] = useState<ReadCluster>("mainnet");
  const [address, setAddress] = useState("");
  const [found, setFound] = useState<{ pair: string; operators: Operator[] } | null>(null);
  const [owner, setOwner] = useState<string>("");
  const [name, setName] = useState("");
  const [periodMin, setPeriodMin] = useState("60");
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const demo = (book as any).markets?.orbt?.lbPair as string | undefined;

  async function find() {
    setError(null);
    setFound(null);
    let key: PublicKey;
    try {
      key = new PublicKey(address.trim());
    } catch {
      return setError("That isn't a Solana address.");
    }
    setBusy("Looking up the address…");
    try {
      const conn = connectionFor(cluster);
      const pos = await resolvePosition(conn, key);
      if (pos) {
        setFound({ pair: pos.pair, operators: [{ owner: pos.owner, positions: [key.toBase58()] }] });
        setOwner(pos.owner);
        return;
      }
      const info = await conn.getAccountInfo(key);
      if (!info) return setError(`Nothing exists at that address on ${cluster}.`);
      if (!info.owner.equals(DLMM_PROGRAM)) return setError("That address isn't a Meteora DLMM pair or position.");
      const operators = await findOperators(conn, key);
      if (!operators.length) return setError("No DLMM positions on that pair right now. Try the operator's position address instead.");
      setFound({ pair: key.toBase58(), operators });
      setOwner(operators[0].owner);
    } catch (e: any) {
      setError(`Couldn't read ${cluster}: ${e?.message?.split("\n")[0] ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    if (!found || !owner) return;
    setBusy("Starting…");
    setError(null);
    try {
      const conn = connectionFor(cluster);
      const s = await newSession(conn, {
        cluster,
        pair: new PublicKey(found.pair),
        owner: new PublicKey(owner),
        periodSecs: Math.max(60, Math.round(Number(periodMin) * 60)),
        twapSecs: Number(periodMin) <= 5 ? 60 : 300,
        operatorName: name || knownName(book, owner) || undefined,
        terms,
      });
      if (cluster === CLUSTER) {
        const labels = await fetchTokenLabels([new PublicKey(s.pairFacts.baseMint), new PublicKey(s.pairFacts.quoteMint)]).catch(() => null);
        s.pairFacts.baseSymbol = labels?.[s.pairFacts.baseMint]?.symbol;
        s.pairFacts.quoteSymbol = labels?.[s.pairFacts.quoteMint]?.symbol;
      }
      s.pairFacts.baseSymbol ??= knownSymbol(s.pairFacts.baseMint);
      s.pairFacts.quoteSymbol ??= knownSymbol(s.pairFacts.quoteMint);
      if (!saveSession(s, sessionLabel(s))) setError("This browser won't store the session (storage is full or blocked); it will run but won't survive a reload.");
      router.push(`/app/monitor?s=${s.id}`);
    } catch (e: any) {
      setError(e?.message?.split("\n")[0] ?? String(e));
      setBusy(null);
    }
  }

  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    <>
      <Link className="crumb" href="/app"><ArrowLeft />Overview</Link>
      <div className="page-head">
        <div>
          <span className="eyebrow">Read-only · no wallet, no deposit</span>
          <h1 className="h1">Monitor an existing arrangement</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "68ch" }}>
            Point this at the pool your operator already manages. It samples the operator&apos;s liquidity at random times, measures it with the Mandate program&apos;s own arithmetic, and builds a service report you can share, replay against other terms, and turn into your next agreement.
          </p>
        </div>
      </div>

      <div className="draft">
        <div className="card">
          <div className="form-section">
            <div className="form-section-head"><span className="h3">1. The pool or position</span><span className="small muted">A Meteora DLMM pair, or one of the operator&apos;s position accounts.</span></div>
            <div className="row wrap" style={{ gap: 10 }}>
              <div className="segmented" role="group" aria-label="Cluster">
                {(["mainnet", "devnet"] as const).map((c) => <button key={c} aria-pressed={cluster === c} onClick={() => (setCluster(c), setFound(null))}>{c === "mainnet" ? "Mainnet" : "Devnet"}</button>)}
              </div>
              {demo && CLUSTER === "devnet" && (
                <button className="btn btn-ghost btn-sm" onClick={() => (setCluster("devnet"), setAddress(demo), setFound(null), setPeriodMin("1"))}>Try the test network&apos;s ORBT pool</button>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input className="input mono" style={{ flex: 1 }} placeholder="Pair or position address" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} onKeyDown={(e) => e.key === "Enter" && find()} />
              <button className="btn btn-secondary" onClick={find} disabled={!!busy || !address.trim()}><Search />Find</button>
            </div>
          </div>

          {found && (
            <div className="form-section">
              <div className="form-section-head">
                <span className="h3">2. Confirm the operator</span>
                <span className="small muted">Wallets holding DLMM positions on <Address value={found.pair} />. Pick the one your operator uses.</span>
              </div>
              <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                {found.operators.slice(0, 40).map((o) => (
                  <label key={o.owner} className="row" style={{ gap: 10, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 10, cursor: "pointer", background: owner === o.owner ? "var(--surface-3)" : undefined }}>
                    <input type="radio" name="owner" checked={owner === o.owner} onChange={() => setOwner(o.owner)} />
                    <span className="mono small">{shortAddr(o.owner, 6)}</span>
                    {knownName(book, o.owner) && <span className="small">{knownName(book, o.owner)}</span>}
                    <span className="xs muted" style={{ marginLeft: "auto" }}>{o.positions.length} position{o.positions.length === 1 ? "" : "s"}</span>
                  </label>
                ))}
              </div>
              <label className="field"><span className="field-label">Operator&apos;s name (for the report)</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={knownName(book, owner) ?? "e.g. the firm you pay"} /></label>
            </div>
          )}

          {found && (
            <div className="form-section">
              <div className="form-section-head">
                <span className="h3">3. What to check against</span>
                <span className="small muted">Your current terms, if you have them. Nothing is locked in: any other terms can be replayed against the same observations later.</span>
              </div>
              <div className="form-grid">
                <label className="field"><span className="field-label">Depth each side<InfoTip>Committed liquidity in quote, valued bin by bin.</InfoTip></span><input className="input" inputMode="decimal" value={terms.minDepth} onChange={(e) => setTerms({ ...terms, minDepth: num(e.target.value) })} /></label>
                <label className="field"><span className="field-label">Measured within (bps)</span><input className="input" inputMode="decimal" value={terms.depthWindowBps} onChange={(e) => setTerms({ ...terms, depthWindowBps: num(e.target.value) })} /></label>
                <label className="field"><span className="field-label">Max spread (bps)</span><input className="input" inputMode="decimal" value={terms.maxSpreadBps} onChange={(e) => setTerms({ ...terms, maxSpreadBps: num(e.target.value) })} /></label>
                <label className="field"><span className="field-label">Report period (min)<InfoTip>Each period is met, missed, incomplete or unobserved. Hourly is typical; one minute suits a quick demo.</InfoTip></span><input className="input" inputMode="decimal" value={periodMin} onChange={(e) => setPeriodMin(e.target.value)} /></label>
              </div>
              <button className="btn btn-primary btn-lg" onClick={start} disabled={!!busy || !owner}><Play />Start observing</button>
            </div>
          )}
          {(busy || error) && <div className="form-section">{busy && <span className="small muted">{busy}</span>}{error && <div className="notice warn small">{error}</div>}</div>}
        </div>

        <div className="card card-pad draft-preview" style={{ display: "grid", gap: 12 }}>
          <span className="h3">What you get</span>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: "var(--ink-2)" }}>
            <li>A period-by-period record: met, missed, incomplete evidence, or not observed. Never a guess.</li>
            <li>Committed depth measured exactly as a Mandate agreement would, and, separately, what traders could actually execute.</li>
            <li>A shareable report link, and terms derived from what the operator really delivered, ready to negotiate.</li>
          </ul>
          <span className="xs muted">Observation runs in this tab while it&apos;s open. For unattended monitoring over days, run the command-line verifier and import its file under Reports.</span>
        </div>
      </div>
    </>
  );
}

const sessionLabel = (s: Session) => `${s.pairFacts.baseSymbol ?? shortAddr(s.pairFacts.baseMint, 3)}/${s.pairFacts.quoteSymbol ?? shortAddr(s.pairFacts.quoteMint, 3)} · ${s.operatorName ?? shortAddr(s.owner ?? s.position ?? "", 4)}`;

function Observing({ id }: { id: string }) {
  const router = useRouter();
  const [initial, setInitial] = useState<Session | null | undefined>(undefined);
  useEffect(() => setInitial(loadSession(id)), [id]);
  if (initial === undefined) return null;
  if (!initial) {
    return (
      <div className="card empty-state" style={{ marginTop: 20 }}>
        <span className="h3" style={{ color: "var(--ink)" }}>This session isn&apos;t in this browser</span>
        <span className="small">Sessions live in the browser that started them. Import an exported session file under Reports, or start a new one.</span>
        <button className="btn btn-secondary btn-sm" onClick={() => router.push("/app/monitor")}>Start a new session</button>
      </div>
    );
  }
  return <Live initial={initial} />;
}

function Live({ initial }: { initial: Session }) {
  const router = useRouter();
  const now = useNow(5_000);
  const label = sessionLabel(initial);
  const obs = useObserver(initial, label);
  const s = obs.session ?? initial;
  const [terms, setTerms] = useState<EvalTerms>(s.terms ?? DEFAULT_TERMS);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => obs.start(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const quote = s.pairFacts.quoteSymbol ?? "quote";
  const sizes = useMemo(() => [terms.minDepth / 5, terms.minDepth, terms.minDepth * 4].map((x) => Math.max(10, Math.round(x / 10) * 10)), [terms.minDepth]);
  const e = useMemo(() => evaluate(s, terms, { tradeSizes: sizes, until: now }), [s, terms, sizes, now]);
  const codes = e.periods.map((p) => ({ met: "m", missed: "x", unknown: "u", unobserved: "-" })[p.verdict]).join("");
  const lastSample = s.samples[s.samples.length - 1];
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  async function share() {
    const link = `${window.location.origin}/app/report#r=${await packLink(shareable(s, e))}`;
    setNote((await copyText(link)) ? "Report link copied. Anyone with it can open the report; it contains no keys." : link);
  }
  function exportFile() {
    const blob = new Blob([JSON.stringify(s)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.id}.session.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function draft() {
    const sug = suggestTerms(s, terms.depthWindowBps);
    const base = PRESETS[0].terms;
    const t = sug?.terms ?? terms;
    const evidence = `/app/report#r=${await packLink(shareable(s, e))}`;
    router.push(
      await prefillLink({
        market: { cluster: s.cluster, baseMint: s.pairFacts.baseMint, quoteMint: s.pairFacts.quoteMint, lbPair: s.pair, referencePool: "", base: s.pairFacts.baseSymbol, quote: s.pairFacts.quoteSymbol },
        terms: { ...base, periodMinutes: String(Math.max(1, s.periodSecs / 60)), minDepth: String(t.minDepth), depthWindowBps: String(t.depthWindowBps), maxSpreadBps: String(t.maxSpreadBps) },
        operator: s.owner ?? undefined,
        evidence,
        basis: sug ? `Service levels derived from observation. ${sug.basis}` : "Service levels copied from the terms this session checked.",
        title: `${label} agreement`,
      }),
    );
  }

  return (
    <>
      <Link className="crumb" href="/app/monitoring"><ArrowLeft />Monitoring</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Observing · {s.cluster} · read-only</span>
          <h1 className="h1">{label}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Pair <Address value={s.pair} /> · operator {s.owner ? <Address value={s.owner} /> : "(position)"} · started {ago(Math.max(0, now - s.startedAt))} · {s.samples.length} sample{s.samples.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {obs.running ? <button className="btn btn-secondary" onClick={obs.pause}><Pause />Pause</button> : <button className="btn btn-secondary" onClick={obs.start}><Play />Resume</button>}
          <button className="btn btn-secondary" onClick={share} disabled={!s.samples.length}><Share2 />Share report</button>
          <button className="btn btn-primary" onClick={draft} disabled={!e.summary.measured}><FilePen />Draft terms from this</button>
        </div>
      </div>
      {note && <div className="notice small" style={{ marginBottom: 16, wordBreak: "break-all" }}>{note}</div>}

      <div className="grid-main">
        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Periods</span><span className="xs muted">{s.periodSecs / 60}-minute periods since observation started</span></div>
            <div className="card-body"><PeriodStrip codes={codes} periodSecs={s.periodSecs} startedAt={s.startedAt} /></div>
          </div>
          <div className="card">
            <div className="card-head">
              <span className="h3">Replayed against terms</span>
              <span className="xs muted">Change them to replay the same observations</span>
            </div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              <div className="form-grid">
                <label className="field"><span className="field-label">Depth each side ({quote})</span><input className="input" inputMode="decimal" value={terms.minDepth} onChange={(ev) => setTerms({ ...terms, minDepth: num(ev.target.value) })} /></label>
                <label className="field"><span className="field-label">Measured within (bps)</span><input className="input" inputMode="decimal" value={terms.depthWindowBps} onChange={(ev) => setTerms({ ...terms, depthWindowBps: num(ev.target.value) })} /></label>
                <label className="field"><span className="field-label">Max spread (bps)</span><input className="input" inputMode="decimal" value={terms.maxSpreadBps} onChange={(ev) => setTerms({ ...terms, maxSpreadBps: num(ev.target.value) })} /></label>
              </div>
              <ReplaySummary s={e.summary} failures={e.failures} observed={e.observed} terms={terms} quote={quote} unobserved={e.summary.unobserved} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><span className="h3">What traders could execute</span><span className="xs muted">Not part of any agreement</span></div>
            <div className="card-body"><ExecutionTable rows={e.execution} quote={quote} /></div>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><span className="h3">Evidence</span><span className="xs muted">{obs.running ? (obs.nextAt ? `next sample in ${countdown(Math.max(0, obs.nextAt - now))}` : "sampling") : "paused"}</span></div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              <ReadinessPanel r={e.readiness} />
              {lastSample && (
                <span className="xs muted">
                  Last sample {ago(Math.max(0, now - lastSample.at))}: reference {lastSample.reference.state}
                  {lastSample.problem ? `; ${lastSample.problem}` : ""}.
                </span>
              )}
              {obs.lastError && <div className="notice warn xs">Last read failed: {obs.lastError}. Retrying.</div>}
              {!obs.saved && <div className="notice warn xs">This browser refused to store the session; export it before closing the tab.</div>}
            </div>
            <div className="card-foot" style={{ display: "grid", gap: 8 }}>
              <span className="xs muted">Observation runs while this tab is open. For days of unattended monitoring:</span>
              <code className="xs mono" style={{ wordBreak: "break-all" }}>npx tsx scripts/verify.ts --cluster {s.cluster} --pair {s.pair} --owner {s.owner} --period-min {s.periodSecs / 60} --hours 72</code>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={exportFile}><Download />Export session</button>
                <button className="btn btn-ghost btn-sm" onClick={() => (deleteSession(s.id), router.push("/app/reports"))}><Trash2 />Delete</button>
              </div>
            </div>
          </div>
          <div className="card card-pad" style={{ display: "grid", gap: 8 }}>
            <span className="h3">From report to agreement</span>
            <span className="small muted">
              When the evidence is enough, share the report with your team or operator, then draft terms from what was actually delivered. The draft shows both sides the capital, payments and failure conditions before anyone signs or deposits.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
