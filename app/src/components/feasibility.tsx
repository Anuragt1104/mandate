"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { CircleAlert } from "lucide-react";
import { economics, type DraftMarket, type DraftTerms } from "../../../sdk/src/draft";
import { evaluate, forecastMoves, type EvalTerms } from "../../../sdk/src/report";
import type { Session } from "../../../sdk/src/observe";
import { connectionFor, type ReadCluster } from "@/lib/chain";
import { listSessions, loadSession } from "@/lib/local";
import { duration, fmt } from "./ui";

export interface Option {
  label: string;
  terms: DraftTerms;
}

const evalTerms = (t: DraftTerms): EvalTerms => ({ minDepth: Number(t.minDepth) || 0, depthWindowBps: Number(t.depthWindowBps) || 0, maxSpreadBps: Number(t.maxSpreadBps) || 0 });

/** The pair's current price (quote per token, UI units) and bin step, for inventory cover. */
function usePairPrice(market: DraftMarket) {
  const [p, setP] = useState<{ price: number; binStep: number } | null>(null);
  useEffect(() => {
    setP(null);
    let key: PublicKey;
    try {
      key = new PublicKey(market.lbPair);
    } catch {
      return;
    }
    const conn = connectionFor(market.cluster as ReadCluster);
    (async () => {
      const info = await conn.getAccountInfo(key);
      if (!info) return;
      const d = info.data;
      const active = d.readInt32LE(76);
      const binStep = d.readUInt16LE(80);
      const mints = await conn.getMultipleAccountsInfo([new PublicKey(d.subarray(88, 120)), new PublicKey(d.subarray(120, 152))]);
      if (!mints[0] || !mints[1]) return;
      setP({ price: Math.pow(1 + binStep / 10_000, active) * 10 ** (mints[0].data[44] - mints[1].data[44]), binStep });
    })().catch(() => undefined);
  }, [market.lbPair, market.cluster]);
  return p;
}

/**
 * What each side would commit and what the terms imply, for up to three options side by
 * side: capital, payments, inventory cover, a replay against real observations of this pool,
 * and a what-if for reference moves. Replay and what-if are labelled apart; neither is a forecast
 * of profit.
 */
export function Feasibility({ market, options }: { market: DraftMarket; options: Option[] }) {
  const price = usePairPrice(market);
  const [sessionId, setSessionId] = useState<string>("");
  const sessions = useMemo(() => (typeof window === "undefined" ? [] : listSessions().filter((s) => s.pair === market.lbPair)), [market.lbPair]);
  useEffect(() => {
    if (sessions[0] && !sessionId) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);
  const session: Session | null = useMemo(() => (sessionId ? loadSession(sessionId) : null), [sessionId]);
  const quote = market.quote ?? "quote";
  const base = market.base ?? "tokens";
  const econ = options.map((o) => economics(o.terms));
  const replays = session ? options.map((o) => evaluate(session, evalTerms(o.terms))) : null;
  const main = options[0];
  const forecast = session ? forecastMoves(session, evalTerms(main.terms), Number(main.terms.speedPctPerMin) || null) : null;

  const row = (label: string, cells: React.ReactNode[], hint?: string) => (
    <tr>
      <td>{label}{hint && <div className="xs muted">{hint}</div>}</td>
      {cells.map((c, i) => <td key={i} className="r num">{c}</td>)}
    </tr>
  );
  const differs = (f: (t: DraftTerms) => string) => options.length > 1 && new Set(options.map((o) => f(o.terms))).size > 1;
  const mark = (changed: boolean, v: React.ReactNode) => (changed ? <b style={{ color: "var(--ink)" }}>{v}</b> : v);

  // Inventory cover for the first option at today's price.
  const t = main.terms;
  const minDepth = Number(t.minDepth) || 0;
  const askValue = price ? (Number(t.baseDeposit) || 0) * price.price : null;
  const bidValue = Number(t.quoteDeposit) || 0;

  const cantConclude: string[] = [];
  if (!session) cantConclude.push("How this operator performs on this pool: there's no observation of it in this browser. Start one from Monitor, or import a verifier file.");
  else {
    const r = evaluate(session, evalTerms(main.terms)).readiness;
    if (!r.ready) cantConclude.push(`Whether the replay is representative: ${r.needs.join(" ")}`);
  }
  cantConclude.push("Future volatility and order flow: the replay covers only the observed span, and the what-if looks at one snapshot.");
  cantConclude.push("The operator's own costs (capital, hedging, running bots); only it can say whether the fee covers them.");
  if (!price) cantConclude.push("Inventory cover: the pair's price couldn't be read.");

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="table-wrap">
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th></th>{options.map((o) => <th key={o.label} className="r">{o.label}</th>)}</tr></thead>
          <tbody>
            {row("Team puts in", econ.map((e, i) => mark(differs((x) => `${x.baseDeposit}|${x.quoteDeposit}|${x.feePerPeriod}|${x.durationPeriods}`), <>{fmt(e.teamBase, 0)} {base}<br />{fmt(e.teamQuote, 0)} {quote}</>)), "inventory, plus every fee up front")}
            {row("Operator locks", econ.map((e) => mark(differs((x) => x.bond), `${fmt(e.bond, 0)} ${quote}`)), "bond, for the whole term")}
            {row("Most the operator earns", econ.map((e) => mark(differs((x) => `${x.feePerPeriod}|${x.durationPeriods}`), `${fmt(e.maxPayment, 0)} ${quote}`)), "if every period passes")}
            {row("Return on bond", econ.map((e) => (e.returnOnBond === null ? "—" : `${(e.returnOnBond * 100).toFixed(0)}%${e.annualised !== null && isFinite(e.annualised) ? ` · ${e.annualised > 10 ? ">1,000" : (e.annualised * 100).toFixed(0)}%/yr` : ""}`)))}
            {row("Term", econ.map((e, i) => mark(differs((x) => `${x.periodMinutes}|${x.durationPeriods}`), `${duration(e.termHours * 3600)} · ${options[i].terms.periodMinutes} min periods`)))}
            {row("Service levels", options.map((o) => mark(differs((x) => `${x.minDepth}|${x.depthWindowBps}|${x.maxSpreadBps}`), <>≥ {fmt(Number(o.terms.minDepth), 0)} {quote} within {o.terms.depthWindowBps} bps<br />spread ≤ {o.terms.maxSpreadBps} bps</>)))}
            {row("Breach", options.map((o, i) => mark(differs((x) => `${x.maxConsecutiveFailures}|${x.slashPct}|${x.bond}`), `${o.terms.maxConsecutiveFailures} failed periods · ${fmt(econ[i].slashAmount, 0)} ${quote}`)))}
            {row("Reference", options.map((o) => mark(differs((x) => `${x.twapMinutes}|${x.speedPctPerMin}`), `${o.terms.twapMinutes} min TWAP · ≤ ${o.terms.speedPctPerMin}%/min`)))}
            {replays && row("Replay: periods met", replays.map((r) => (r.summary.decided ? `${r.summary.met} of ${r.summary.decided}` : "—")), "on the observed span")}
            {replays && row("Replay: checks failing", replays.map((r) => (r.summary.measured ? `bids ${r.failures.bids} · asks ${r.failures.asks} · spread ${r.failures.spread}` : "—")))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <span className="h3" style={{ fontSize: 14 }}>Inventory cover{options.length > 1 ? ` (${main.label})` : ""}</span>
        {price && askValue !== null && minDepth > 0 ? (
          <>
            <span className="small" style={{ color: "var(--ink-2)" }}>
              Asks: {fmt(Number(t.baseDeposit) || 0, 0)} {base} ≈ <b>{fmt(askValue, 0)} {quote}</b> at today&apos;s price, {(askValue / minDepth).toFixed(1)}× the minimum.
              {" "}Bids: <b>{fmt(bidValue, 0)} {quote}</b>, {(bidValue / minDepth).toFixed(1)}× the minimum.
            </span>
            <span className="small" style={{ color: askValue < 2 * minDepth || bidValue < 2 * minDepth ? "var(--warn)" : "var(--ink-2)" }}>
              Net buying of roughly {fmt(Math.max(0, askValue - minDepth), 0)} {quote} (or net selling of {fmt(Math.max(0, bidValue - minDepth), 0)} {quote}) moves the price through the committed side; once the reference follows, the operator can&apos;t quote the minimum again, because the vault can only quote, not buy.
            </span>
          </>
        ) : (
          <span className="small muted">Set the pair and a depth to see how far the inventory stretches.</span>
        )}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div className="row-between wrap" style={{ gap: 8 }}>
          <span className="h3" style={{ fontSize: 14 }}>Replay on observations</span>
          {sessions.length > 0 && (
            <select className="input" style={{ maxWidth: 260, padding: "4px 8px" }} value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.samples} sample{s.samples === 1 ? "" : "s"}</option>)}
            </select>
          )}
        </div>
        {session ? (
          <span className="small muted">Each option above was replayed against {session.samples.length} real sample{session.samples.length === 1 ? "" : "s"} of this pool: what would have happened, not what will.</span>
        ) : (
          <span className="small muted">No observation of this pool in this browser yet.</span>
        )}
      </div>

      {forecast && forecast.rows.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <span className="h3" style={{ fontSize: 14 }}>What-if: the reference moves and the operator does nothing</span>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 13 }}>
              <thead><tr><th>Move</th><th className="r">Still meets {main.label}?</th><th className="r">Bids / asks</th><th className="r">Reference needs at least</th></tr></thead>
              <tbody>
                {forecast.rows.map((r) => (
                  <tr key={r.movePct}>
                    <td className="num">{r.movePct > 0 ? "+" : ""}{r.movePct}%</td>
                    <td className="r" style={{ color: r.passes ? "var(--up)" : r.passes === false ? "var(--down)" : undefined }}>{r.passes === null ? "unknown" : r.passes ? "yes" : "no"}</td>
                    <td className="r num">{r.bid === null ? "—" : `${fmt(r.bid, 0)} / ${fmt(r.ask ?? 0, 0)}`}</td>
                    <td className="r num">{r.minutesAtSpeedLimit === null ? "—" : `${r.minutesAtSpeedLimit.toFixed(0)} min`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="xs muted">A what-if on the latest observed book, not a prediction. &quot;Reference needs at least&quot; is how fast the speed limit lets the reference move that far: the operator&apos;s time to re-centre before checks start failing.</span>
        </div>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <span className="h3" style={{ fontSize: 14 }}>What this can&apos;t tell you</span>
        {cantConclude.map((c) => (
          <span key={c} className="small row" style={{ gap: 6, alignItems: "flex-start", color: "var(--ink-2)" }}><CircleAlert style={{ width: 14, flex: "none", marginTop: 3, color: "var(--muted)" }} />{c}</span>
        ))}
      </div>
    </div>
  );
}
