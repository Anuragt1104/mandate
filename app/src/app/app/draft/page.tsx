"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ArrowLeft, Check, CircleAlert, Copy, FilePen, PenLine, Send } from "lucide-react";
import {
  GROUP_LABELS,
  TERM_FIELDS,
  approvalMessage,
  approvalState,
  base58Encode,
  diffTerms,
  draftToChain,
  newDraft,
  propose,
  type ApprovalState,
  type DraftDoc,
  type DraftMarket,
  type DraftTerms,
  type Party,
} from "../../../../../sdk/src/draft";
import { pda } from "../../../../../sdk/src";
import { CLUSTER, connectionFor, fetchMints, type ReadCluster } from "@/lib/chain";
import { PRESETS, copyText, draftLink, readHash, type DraftPrefill } from "@/lib/drafts";
import { rememberDraft } from "@/lib/local";
import { useMandateActions } from "@/lib/actions";
import { usePersonas } from "@/lib/personas";
import { Feasibility, type Option } from "@/components/feasibility";
import { Address, InfoTip, ago, shortAddr } from "@/components/ui";
import { useNow } from "@/lib/hooks";

const isKey = (s?: string) => {
  try {
    return !!s && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};

const EMPTY_MARKET: DraftMarket = { cluster: CLUSTER, baseMint: "", quoteMint: "", lbPair: "", referencePool: "" };

export default function DraftPage() {
  const [doc, setDoc] = useState<DraftDoc | null>(null);
  const [basis, setBasis] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Opening another draft link on this page only changes the fragment: load it afresh.
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const onHash = () => setNonce((n) => n + 1);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    (async () => {
      const d = await readHash<DraftDoc>("d");
      if (d?.kind === "mandate-draft") setDoc(d);
      else {
        const p = await readHash<DraftPrefill>("p");
        setDoc(newDraft(p?.market ?? EMPTY_MARKET, p?.terms ?? PRESETS[0].terms, "team", { title: p?.title, operator: p?.operator, team: p?.team, evidence: p?.evidence, renews: p?.renews }));
        setBasis(p?.basis ?? null);
      }
      setLoaded(true);
    })();
  }, [nonce]);
  if (!loaded || !doc) return null;
  return <Draft key={nonce} initial={doc} basis={basis} />;
}

function Draft({ initial, basis }: { initial: DraftDoc; basis: string | null }) {
  const { publicKey, signMessage } = useWallet();
  const book = usePersonas();
  const now = useNow(30_000);
  const [doc, setDoc] = useState(initial);
  const latest = doc.versions[doc.versions.length - 1];
  const [working, setWorking] = useState<DraftTerms>(latest.terms);
  const [note, setNote] = useState("");
  const [state, setState] = useState<ApprovalState | null>(null);
  const [link, setLink] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [binStep, setBinStep] = useState<number | null>(null);
  const me = publicKey?.toBase58() ?? null;
  const role: Party | null = me && me === doc.team ? "team" : me && me === doc.operator ? "operator" : null;
  const edited = diffTerms(latest.terms, working);
  const approved = !!state && (!!state.team || !!state.operator);
  const locked = !!doc.posted;

  // Keep the shareable link and the local list in step with the document.
  useEffect(() => {
    (async () => {
      const st = await approvalState(doc);
      setState(st);
      const l = await draftLink(doc);
      setLink(l);
      window.history.replaceState(null, "", l);
      rememberDraft(doc, l, doc.posted ? "Posted" : st.agreed ? "Both approved: ready to fund" : `Version ${st.latest.n} · ${st.team ? "team approved" : st.operator ? "operator approved" : "awaiting approval"}`);
    })();
  }, [doc]);

  // Fill in the mints from the pair, and the graduated pool on the test network.
  useEffect(() => {
    if (!isKey(doc.market.lbPair)) return;
    const conn = connectionFor(doc.market.cluster as ReadCluster);
    conn
      .getAccountInfo(new PublicKey(doc.market.lbPair))
      .then((info) => {
        if (!info) return;
        const d = info.data;
        setBinStep(d.readUInt16LE(80));
        const baseMint = new PublicKey(d.subarray(88, 120)).toBase58();
        const quoteMint = new PublicKey(d.subarray(120, 152)).toBase58();
        const known = Object.values(((book as any).markets ?? {}) as Record<string, any>).find((m: any) => m.lbPair === doc.market.lbPair);
        const quoteSym = (book as any).tokens?.[quoteMint]?.symbol;
        if (baseMint !== doc.market.baseMint || quoteMint !== doc.market.quoteMint || (known && !doc.market.referencePool))
          setDoc((x) => ({ ...x, market: { ...x.market, baseMint, quoteMint, referencePool: x.market.referencePool || known?.dammPool || "", base: x.market.base ?? known?.symbol, quote: x.market.quote ?? quoteSym } }));
      })
      .catch(() => undefined);
  }, [doc.market.lbPair, doc.market.cluster, book]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMarket = (k: keyof DraftMarket, v: string) => setDoc({ ...doc, market: { ...doc.market, [k]: v.trim() } });
  const setParty = (k: "team" | "operator", v: string) => setDoc({ ...doc, [k]: v.trim() || undefined });

  const errors = useMemo(() => {
    const e: string[] = [];
    for (const f of TERM_FIELDS) if (!(Number(working[f.key]) >= 0) || working[f.key].trim() === "") e.push(`${f.label}: enter a number.`);
    if (Number(working.durationPeriods) < 1) e.push("At least one period.");
    if (Number(working.periodMinutes) < 1) e.push("Periods of at least a minute.");
    if (binStep && Number(working.depthWindowBps) < binStep) e.push(`The depth window must be at least the pair's bin step (${binStep} bps).`);
    if (Number(working.liquidityLockSecs) > Number(working.periodMinutes) * 60) e.push("The liquidity lock can't exceed a period.");
    return e;
  }, [working, binStep]);

  function doPropose(by: Party) {
    if (errors.length) return;
    setDoc(propose(doc, working, by, note.trim() || undefined));
    setNote("");
    setMsg({ kind: "info", text: `Version ${latest.n + 1} proposed. Send the link to the other side; approvals on earlier versions no longer count.` });
  }

  async function approve() {
    if (!role || !signMessage || !state) return;
    try {
      const sig = await signMessage(approvalMessage(state.hash, role));
      setDoc({ ...doc, approvals: [...doc.approvals, { n: state.latest.n, party: role, signer: me!, hash: state.hash, sig: base58Encode(sig) }] });
      setMsg({ kind: "info", text: `Approved version ${state.latest.n} as the ${role === "team" ? "team" : "operator"}. Send the updated link back.` });
    } catch (e: any) {
      setMsg({ kind: "warn", text: /reject/i.test(String(e?.message)) ? "You declined to sign." : `Couldn't sign: ${e?.message ?? e}` });
    }
  }

  async function share() {
    const full = `${window.location.origin}${link}`;
    setMsg((await copyText(full)) ? { kind: "info", text: "Link copied. It carries the whole draft; anyone with it can read the terms." } : { kind: "info", text: full });
  }

  const quote = doc.market.quote ?? "quote";
  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    if (edited.length) out.push({ label: "Your edit", terms: working });
    for (const v of [...doc.versions].reverse()) if (out.length < 3) out.push({ label: `v${v.n}${v.n === latest.n ? " (latest)" : ""}`, terms: v.terms });
    return out;
  }, [doc.versions, working, edited.length, latest.n]);

  const partyName = (a?: string) => (a ? book.parties[a]?.name ?? shortAddr(a, 4) : "not set");
  return (
    <>
      <Link className="crumb" href="/app/reports"><ArrowLeft />Reports</Link>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Shared draft · nothing moves until both approve and the team funds it</span>
          <h1 className="h1">{doc.title ?? "Draft agreement"}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Version {latest.n}, proposed by the {latest.by} {ago(Math.max(0, now - latest.at))}.{doc.renews && <> Renews <Link className="link" href={`/app/mandate/${doc.renews}`}>{shortAddr(doc.renews, 4)}</Link>.</>}
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-secondary" onClick={share}><Copy />Copy link to send</button>
        </div>
      </div>
      {msg && <div className={`notice ${msg.kind === "warn" ? "warn" : ""} small`} style={{ marginBottom: 16, wordBreak: "break-all" }}>{msg.text}</div>}
      {basis && doc.versions.length === 1 && <div className="notice subtle small" style={{ marginBottom: 16 }}>{basis}{doc.evidence && <> <Link className="link" href={doc.evidence}>Open the report</Link>.</>}</div>}

      <div className="draft">
        <div className="stack">
          <div className="card">
            <div className="form-section">
              <div className="form-section-head"><span className="h3">Market and parties</span><span className="small muted">Part of what both sides sign: changing them needs fresh approvals.</span></div>
              <div className="form-grid">
                <label className="field span-2"><span className="field-label">DLMM pair ({doc.market.cluster})</span><input className="input mono" disabled={locked} value={doc.market.lbPair} onChange={(e) => setMarket("lbPair", e.target.value)} /></label>
                <label className="field span-2"><span className="field-label">Graduated pool (DAMM v2)<InfoTip>Needed to post the agreement; the program shows its price beside the reference for comparison.</InfoTip></span><input className="input mono" disabled={locked} value={doc.market.referencePool} onChange={(e) => setMarket("referencePool", e.target.value)} placeholder="needed before funding" /></label>
                <label className="field"><span className="field-label">Team wallet (funds it)</span><input className="input mono" disabled={locked} value={doc.team ?? ""} onChange={(e) => setParty("team", e.target.value)} placeholder="the issuer's wallet" /></label>
                <label className="field"><span className="field-label">Operator wallet (designated maker)</span><input className="input mono" disabled={locked} value={doc.operator ?? ""} onChange={(e) => setParty("operator", e.target.value)} placeholder="the operator's wallet" /></label>
              </div>
              {me && !doc.team && me !== doc.operator && <button className="btn btn-ghost btn-sm" onClick={() => setParty("team", me)}>Use my connected wallet as the team</button>}
              {me && !doc.operator && me !== doc.team && <button className="btn btn-ghost btn-sm" onClick={() => setParty("operator", me)}>I&apos;m the operator: use my wallet</button>}
            </div>
          </div>

          <div className="card">
            <div className="form-section">
              <div className="form-section-head">
                <span className="h3">Terms</span>
                <span className="small muted">{edited.length ? `${edited.length} change${edited.length === 1 ? "" : "s"} from version ${latest.n}, not proposed yet.` : `As in version ${latest.n}.`}</span>
              </div>
              {!locked && (
                <div className="presets">
                  {PRESETS.map((p) => (
                    <button key={p.id} className="preset" onClick={() => setWorking({ ...p.terms, baseDeposit: working.baseDeposit, quoteDeposit: working.quoteDeposit })}>
                      <b className="small">{p.name}</b><span className="xs muted">{p.blurb}</span>
                    </button>
                  ))}
                </div>
              )}
              {(Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[]).map((g) => (
                <div key={g} style={{ display: "grid", gap: 8 }}>
                  <span className="xs muted" style={{ fontWeight: 600 }}>{GROUP_LABELS[g]}</span>
                  <div className="form-grid">
                    {TERM_FIELDS.filter((f) => f.group === g).map((f) => {
                      const changed = Number(working[f.key]) !== Number(latest.terms[f.key]);
                      return (
                        <label key={f.key} className="field">
                          <span className="field-label">{f.label}{f.unit && <span className="muted"> ({f.unit === "quote" ? quote : f.unit === "base" ? doc.market.base ?? "tokens" : f.unit})</span>}</span>
                          <input className="input" inputMode="decimal" disabled={locked} value={working[f.key]} onChange={(e) => setWorking({ ...working, [f.key]: e.target.value })}
                            style={changed ? { borderColor: "var(--ink)", boxShadow: "inset 0 0 0 1px var(--ink)" } : undefined} />
                          {changed && <span className="field-hint">was {latest.terms[f.key]}</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {errors.length > 0 && edited.length > 0 && <div className="notice warn small">{errors.join(" ")}</div>}
              {edited.length > 0 && !locked && (
                <div style={{ display: "grid", gap: 8 }}>
                  <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why these changes (the other side sees this)" />
                  <div className="row wrap" style={{ gap: 8 }}>
                    <button className="btn btn-primary" disabled={!!errors.length} onClick={() => doPropose(role ?? (me === doc.operator ? "operator" : "team"))}><PenLine />Propose as version {latest.n + 1}{role ? ` (${role})` : ""}</button>
                    <button className="btn btn-ghost" onClick={() => setWorking(latest.terms)}>Discard changes</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><span className="h3">Versions</span><span className="xs muted">What each side changed, newest first</span></div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              {[...doc.versions].reverse().map((v, i, arr) => {
                const prev = arr[i + 1];
                const changes = prev ? diffTerms(prev.terms, v.terms) : [];
                return (
                  <div key={v.n} style={{ display: "grid", gap: 4 }}>
                    <span className="small"><b>Version {v.n}</b> · {v.by === "team" ? `team (${partyName(doc.team)})` : `operator (${partyName(doc.operator)})`} · {ago(Math.max(0, now - v.at))}</span>
                    {v.note && <span className="small" style={{ color: "var(--ink-2)" }}>&ldquo;{v.note}&rdquo;</span>}
                    {prev ? (
                      changes.length ? changes.map((c) => <span key={c.key} className="xs"><span className="muted">{c.group} · {c.label}:</span> {c.from} → <b>{c.to}</b></span>) : <span className="xs muted">No change to the terms.</span>
                    ) : <span className="xs muted">First proposal.</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <Approvals doc={doc} state={state} role={role} me={me} edited={edited.length > 0} canSign={!!signMessage} onApprove={approve} onDoc={setDoc} onMsg={setMsg} />
        </div>

        <div className="card card-pad draft-preview" style={{ display: "grid", gap: 12, maxHeight: "calc(100vh - 100px)", overflowY: "auto" }}>
          <div className="row-between"><span className="h3">Feasibility</span><span className="xs muted">before anyone signs</span></div>
          <Feasibility market={doc.market} options={options} />
        </div>
      </div>
    </>
  );
}

function Approvals({ doc, state, role, me, edited, canSign, onApprove, onDoc, onMsg }: {
  doc: DraftDoc;
  state: ApprovalState | null;
  role: Party | null;
  me: string | null;
  edited: boolean;
  canSign: boolean;
  onApprove: () => void;
  onDoc: (d: DraftDoc) => void;
  onMsg: (m: { kind: "info" | "warn"; text: string }) => void;
}) {
  const { run, busy } = useMandateActions();
  if (!state) return null;
  const mine = role && (role === "team" ? state.team : state.operator);
  const fundable = state.agreed && role === "team" && doc.market.cluster === CLUSTER && isKey(doc.market.referencePool) && !doc.posted;

  async function fund() {
    const t = state!.latest.terms;
    const m = doc.market;
    let key: PublicKey | null = null;
    const ok = await run("Fund and post", async (c, me) => {
      const base = new PublicKey(m.baseMint);
      const quote = new PublicKey(m.quoteMint);
      const mints = await fetchMints([base, quote]);
      const bd = mints[m.baseMint]?.decimals;
      const qd = mints[m.quoteMint]?.decimals;
      if (bd === undefined || qd === undefined) throw new Error("Couldn't read the token mints.");
      // Exactly the approved version, converted without rounding.
      const x = draftToChain(t, bd, qd);
      const bn = (v: bigint) => new BN(v.toString());
      const id = Math.floor(Date.now() / 1000);
      key = pda.mandate(me, base, id);
      return [
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(base, me, true), me, base),
        createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(quote, me, true), me, quote),
        await c.createMandate({
          issuer: me, baseMint: base, quoteMint: quote, lbPair: new PublicKey(m.lbPair), referencePool: new PublicKey(m.referencePool), id,
          terms: { ...x.terms, feePerPeriod: bn(x.terms.feePerPeriod), bondAmount: bn(x.terms.bondAmount), minDepthQuote: bn(x.terms.minDepthQuote) },
          baseDeposit: bn(x.baseDeposit), quoteDeposit: bn(x.quoteDeposit), feeBudget: bn(x.feeBudget),
          designatedMaker: new PublicKey(doc.operator!),
        }),
      ];
    }, { done: "Funded and posted. Send the operator the updated link to accept." });
    if (ok && key) {
      onDoc({ ...doc, posted: { mandate: (key as PublicKey).toBase58(), sig: "" } });
      onMsg({ kind: "info", text: "Posted exactly the approved terms. The operator accepts on the agreement page by posting its bond." });
    }
  }

  const who = (a: typeof state.team, party: string, wallet?: string) => (
    <div className="row" style={{ gap: 8 }}>
      {a ? <Check style={{ width: 16, color: "var(--up)" }} /> : <CircleAlert style={{ width: 16, color: "var(--muted)" }} />}
      <span className="small">{party} {wallet ? <Address value={wallet} /> : <span className="muted">(wallet not set)</span>}: {a ? <b>approved version {a.n}</b> : "not yet"}</span>
    </div>
  );
  return (
    <div className="card">
      <div className="card-head"><span className="h3">Approvals</span><span className="xs mono muted" title={state.hash}>terms {state.hash.slice(0, 10)}…</span></div>
      <div className="card-body" style={{ display: "grid", gap: 10 }}>
        {who(state.team, "Team", doc.team)}
        {who(state.operator, "Operator", doc.operator)}
        {state.stale.length > 0 && <span className="xs muted">{state.stale.length} earlier approval{state.stale.length === 1 ? "" : "s"} on other versions or wallets kept for the record; they don&apos;t count.</span>}
        <span className="xs muted">Approving signs the terms hash with your wallet. It moves no funds and costs nothing; it proves both sides agreed to identical terms.</span>
        {!me && <span className="small muted">Reading and proposing need no wallet. To approve, connect the team&apos;s or the operator&apos;s signing wallet (top right).</span>}
        {me && !role && <span className="small muted">Connect the team&apos;s or the operator&apos;s wallet to approve.</span>}
        {me && role && !mine && (
          <button className="btn btn-primary" onClick={onApprove} disabled={edited || !canSign || !doc.team || !doc.operator}>
            <PenLine />Approve version {state.latest.n} as the {role}
          </button>
        )}
        {edited && role && <span className="xs muted">Propose or discard your edits first: approvals apply to a proposed version.</span>}
        {state.agreed && !doc.posted && (
          <div className="notice small" style={{ display: "grid", gap: 8 }}>
            <b style={{ color: "var(--ink)" }}>Both sides approved identical terms.</b>
            {doc.market.cluster !== CLUSTER ? (
              <span>The program runs on {CLUSTER}; this draft is for {doc.market.cluster}. Keep it as the negotiated record.</span>
            ) : !isKey(doc.market.referencePool) ? (
              <span>Add the graduated pool address before funding (that changes the market, so both sides approve again).</span>
            ) : role === "team" ? (
              <button className="btn btn-primary" onClick={fund} disabled={!!busy || !fundable}><Send />Fund and post the approved terms</button>
            ) : (
              <span>{role === "operator" ? "The team funds and posts it; then you accept on the agreement page." : "The team funds and posts it; then the operator accepts on the agreement page."}</span>
            )}
          </div>
        )}
        {doc.posted && (
          <div className="notice small" style={{ display: "grid", gap: 6 }}>
            <b style={{ color: "var(--ink)" }}>Posted on chain.</b>
            <Link className="link" href={`/app/mandate/${doc.posted.mandate}`}>Open the agreement{role === "operator" ? " and accept it" : ""}</Link>
          </div>
        )}
        <Link className="xs link" href="/app/create"><FilePen style={{ width: 12 }} /> Post an open offer to any maker instead</Link>
      </div>
    </div>
  );
}
