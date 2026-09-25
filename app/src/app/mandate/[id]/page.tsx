"use client";

import { use, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchBook, fetchMandate, fetchScoreLog, short, tokenAmounts } from "@/lib/chain";
import { usePoll, useNow } from "@/lib/hooks";
import { useMandateActions } from "@/lib/actions";
import { DepthLadder } from "@/components/DepthLadder";
import { StatusChip, Tape, TapeLegend, duration, fmt, fmtPrice } from "@/components/ui";
import { StrategyType, binArrayIndex, dlmmInitBinArrayIx, statusName } from "../../../../../sdk/src";

const Q = 1e6; // quote-token decimals used for display of terms

async function load(key: PublicKey) {
  const m = await fetchMandate(key);
  if (!m) return null;
  const [log, book, balances] = await Promise.all([
    fetchScoreLog(m.scoreLog),
    fetchBook(m),
    tokenAmounts([m.baseVault, m.quoteVault, m.feeVault, m.bondVault]),
  ]);
  return { m, log, book, balances };
}

function Check({ label, value, target, pass }: { label: string; value: string; target: string; pass: boolean | null }) {
  return (
    <div className={`check ${pass === null ? "" : pass ? "pass" : "miss"}`}>
      <div className="label"><span>{label}</span><span className="mark">{pass === null ? "" : pass ? "✓" : "✕"}</span></div>
      <div className="value">{value}</div>
      <div className="hint">{target}</div>
    </div>
  );
}

export default function MandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const key = new PublicKey(id);
  const { data, error, reload } = usePoll(() => load(key), [id], 10_000);
  const now = useNow();
  const { me, run, busy } = useMandateActions();
  const [pct, setPct] = useState(90);
  const [halfWidth, setHalfWidth] = useState(8);

  if (error && !data) return <div className="empty" style={{ marginTop: 40 }}>Could not load this mandate: {error}</div>;
  if (!data) return <div className="empty" style={{ marginTop: 40 }}>Loading mandate…</div>;
  const { m, log, book, balances } = data;
  const t = m.terms;
  const status = statusName(m.status);
  const bd = book?.baseDecimals ?? 6;
  const qd = book?.quoteDecimals ?? 6;
  const isMaker = !!me && (m.maker as PublicKey).equals(me);
  const isIssuer = !!me && (m.issuer as PublicKey).equals(me);
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);
  const openToAll = (m.maker as PublicKey).equals(PublicKey.default);
  const periodEnd = m.startTs.toNumber() + (m.currentPeriod + 1) * t.periodSecs;
  const last = m.last;
  const checked = m.snapshotsTotal > 0;
  const quoteUi = (v: any) => Number(v.toString()) / 10 ** qd;
  const after = async () => setTimeout(reload, 400);

  // --- Actions -------------------------------------------------------------
  const snapshot = () => run("Snapshot", async (c, me) => [await c.snapshot({ cranker: me, mandate: key, m })], { done: "Snapshot recorded." }).then(after);
  const finalize = () => run("Finalize", async (c) => [await c.finalize({ mandate: key, m })], { done: "Elapsed periods finalized." }).then(after);
  const accept = () =>
    run("Accept", async (c, me) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, me, true), me, m.quoteMint),
      await c.accept({ maker: me, mandate: key, m }),
    ], { done: "Mandate accepted. Your bond is posted." }).then(after);
  const openPosition = () =>
    run("Open position", async (c, me) => {
      const lower = book!.refBin - 35;
      const ixs = [];
      for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + 69); i++) ixs.push(dlmmInitBinArrayIx(m.lbPair, i, me));
      // Bin-array init fails if it already exists, so only include missing ones.
      const infos = await (await import("@/lib/chain")).connection().getMultipleAccountsInfo(ixs.map((ix) => ix.keys[1].pubkey));
      const missing = ixs.filter((_, i) => !infos[i]);
      return [...missing, await c.openPosition({ maker: me, mandate: key, m, lowerBinId: lower, width: 70 })];
    }, { done: "Position opened, centred on the reference price." }).then(after);
  // Bids go at or below the reference, asks at or above it (and DLMM puts quote at or
  // below the active bin, base at or above it), so deploy each side separately.
  const deploy = () =>
    run("Deploy inventory", async (c, me) => {
      const pair = book!.pair;
      const ref = book!.refBin;
      const bandBins = Math.floor(Math.log(1 + t.bandBps / 10_000) / Math.log(1 + pair.binStep / 10_000)) - 1;
      const lower = m.positionLowerBinId as number;
      const upper = lower + (m.positionWidth as number) - 1;
      const lo = Math.max(ref - Math.min(halfWidth, bandBins), lower);
      const hi = Math.min(ref + Math.min(halfWidth, bandBins), upper);
      const f = BigInt(pct);
      const ixs = [];
      const bidMax = Math.min(ref + 1, pair.activeId, hi);
      if (balances[1] > 0n && lo <= bidMax)
        ixs.push(await c.addLiquidity({
          authority: me, mandate: key, m, pair, amountBase: new BN(0), amountQuote: new BN(((balances[1] * f) / 100n).toString()),
          minBinId: lo, maxBinId: bidMax, strategy: StrategyType.SpotImBalanced,
        }));
      const askMin = Math.max(ref, pair.activeId, lo);
      if (balances[0] > 0n && askMin <= hi)
        ixs.push(await c.addLiquidity({
          authority: me, mandate: key, m, pair, amountBase: new BN(((balances[0] * f) / 100n).toString()), amountQuote: new BN(0),
          minBinId: askMin, maxBinId: hi, strategy: StrategyType.SpotImBalanced,
        }));
      if (!ixs.length) throw new Error("Nothing to deploy: the vault is empty or no bins are allowed right now.");
      return ixs;
    }, { done: "Inventory deployed into the DLMM position." }).then(after);
  const pull = (close: boolean) =>
    run(close ? "Unwind" : "Pull liquidity", async (c, me) => {
      const ixs = [await c.removeLiquidity({ authority: me, mandate: key, m, pair: book!.pair })];
      if (close) ixs.push(await c.closePosition({ authority: me, mandate: key, m }));
      return ixs;
    }, { done: close ? "Liquidity returned to the vault and position closed." : "Liquidity returned to the vault." }).then(after);
  const claim = () => run("Claim fees", async (c) => [await c.claimMakerFees({ mandate: key, m })], { done: "Earned fees sent to your wallet." }).then(after);
  const settle = () =>
    run("Settle", async (c, me) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.baseMint, m.issuer, true), m.issuer, m.baseMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.issuer, true), m.issuer, m.quoteMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.maker, true), m.maker, m.quoteMint),
      await c.settle({ mandate: key, m }),
    ], { done: "Mandate settled. Funds distributed." }).then(after);
  const cancel = () => run("Cancel", async (c) => [await c.cancel({ mandate: key, m })], { done: "Mandate cancelled. Funds returned." }).then(after);

  const earnedUnclaimed = quoteUi(m.feesEarned) - quoteUi(m.feesClaimed);

  return (
    <div className="stack" style={{ paddingTop: 24 }}>
      <div className="stack" style={{ gap: 8 }}>
        <Link href="/" className="muted" style={{ fontSize: 13, textDecoration: "none" }}>← All mandates</Link>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h1>{short(m.baseMint, 5)} / {short(m.quoteMint, 5)}</h1>
          <StatusChip status={status} />
        </div>
        {error && <p className="hint">Showing the last loaded data. {error}</p>}
        <div className="addr">
          mandate {short(key, 6)} · issuer {short(m.issuer)} · maker {openToAll ? "open to any maker" : short(m.maker)}
          {isIssuer && " · you are the issuer"}{isMaker && " · you are the maker"}
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Compliance tape</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {status === "Active"
              ? `Period ${m.currentPeriod + 1} of ${t.durationPeriods} · closes in ${duration(Math.max(0, periodEnd - now))}`
              : `${m.periodsOk} compliant · ${m.periodsFailed} failed · ${m.periodsUnobserved} not observed`}
          </span>
        </div>
        <Tape entries={log} live={status === "Active" ? { failed: m.curFailedSnapshots > 0 } : null} total={t.durationPeriods} large />
        <div style={{ marginTop: 10 }}><TapeLegend /></div>
      </section>

      <div className="grid-2">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Latest check</h2>
              <span className="muted" style={{ fontSize: 13 }}>
                {checked ? `${duration(Math.max(0, now - last.ts.toNumber()))} ago · ${m.snapshotsTotal} checks so far` : "No checks yet"}
              </span>
            </div>
            <div className="verdict">
              <Check label="Spread" value={!checked ? "—" : last.spreadBps === 65535 ? "One side empty" : `${last.spreadBps} bps`} target={`target ≤ ${t.maxSpreadBps} bps at ${fmt(quoteUi(t.minDepthQuote) / 10)} size`} pass={checked ? last.spreadBps <= t.maxSpreadBps : null} />
              <Check label="Bids committed" value={checked ? fmt(quoteUi(last.bidDepthQuote)) : "—"} target={`target ≥ ${fmt(quoteUi(t.minDepthQuote))} within ${t.depthWindowBps / 100}% below`} pass={checked ? last.bidDepthQuote.gte(t.minDepthQuote) : null} />
              <Check label="Asks committed" value={checked ? fmt(quoteUi(last.askDepthQuote)) : "—"} target={`target ≥ ${fmt(quoteUi(t.minDepthQuote))} within ${t.depthWindowBps / 100}% above`} pass={checked ? last.askDepthQuote.gte(t.minDepthQuote) : null} />
              <Check label="Reference vs graduated pool" value={checked ? `${last.refDeviationBps} bps` : "—"} target="for information, not scored" pass={null} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>The vault&apos;s quotes</h2>
              <span className="mono muted">
                reference {fmtPrice(book?.refUi ?? 0)} · active {fmtPrice(book?.activeUi ?? 0)} · graduated pool {fmtPrice(book?.dammUi ?? 0)}
              </span>
            </div>
            {book && <DepthLadder bins={book.bins} activeBinId={book.pair.activeId} refBin={book.refBin} refUi={book.refUi} bandBps={t.bandBps} />}
            {book && book.targetBin !== book.refBin && (
              <p className="hint" style={{ marginTop: 8 }}>
                The time-weighted price is {book.targetBin > book.refBin ? "above" : "below"} the reference; the reference is moving toward it at up to {t.anchorSpeedBpsPerMin / 100}% a minute.
              </p>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 style={{ marginBottom: 12 }}>Actions</h2>
            <div className="stack" style={{ gap: 12 }}>
              {status === "Active" && (
                <div className="actions">
                  <button className="btn" onClick={snapshot} disabled={!!busy}>Take a snapshot</button>
                  <button className="btn ghost" onClick={finalize} disabled={!!busy || now < periodEnd}>Finalize periods</button>
                </div>
              )}
              {status === "Open" && (openToAll || isMaker) && !isIssuer && (
                <button className="btn brass" onClick={accept} disabled={!!busy}>Accept and post {fmt(quoteUi(t.bondAmount), 0)} bond</button>
              )}
              {status === "Open" && isIssuer && <button className="btn danger" onClick={cancel} disabled={!!busy}>Cancel mandate</button>}
              {status === "Active" && isMaker && !hasPosition && <button className="btn brass" onClick={openPosition} disabled={!!busy}>Open DLMM position</button>}
              {status === "Active" && isMaker && hasPosition && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="form-grid">
                    <label className="field">Deploy share of idle inventory (%)<input id="deploy-pct" type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} /></label>
                    <label className="field">Bins each side of the reference<input id="deploy-width" type="number" min={1} max={34} value={halfWidth} onChange={(e) => setHalfWidth(Number(e.target.value))} /></label>
                  </div>
                  <div className="actions">
                    <button className="btn brass" onClick={deploy} disabled={!!busy}>Deploy inventory</button>
                    <button className="btn ghost" onClick={() => pull(false)} disabled={!!busy}>Pull liquidity</button>
                  </div>
                  <p className="hint">The program only accepts bids at or below the reference price and asks at or above it, within ±{t.bandBps / 100}%. Pulled liquidity returns to the vault, never to your wallet.</p>
                </div>
              )}
              {isMaker && earnedUnclaimed > 0 && <button className="btn ghost" onClick={claim} disabled={!!busy}>Claim {fmt(earnedUnclaimed)} earned fees</button>}
              {(status === "Breached" || status === "Expired") && (
                <div className="actions">
                  {hasPosition && <button className="btn" onClick={() => pull(true)} disabled={!!busy}>Unwind liquidity</button>}
                  {!hasPosition && <button className="btn brass" onClick={settle} disabled={!!busy}>Settle and distribute</button>}
                </div>
              )}
              {!me && <p className="hint">Connect a wallet to act. Snapshots and settlement are open to anyone.</p>}
              {busy && <p className="hint">{busy}: waiting for confirmation…</p>}
            </div>
          </section>

          <section className="panel">
            <h2 style={{ marginBottom: 12 }}>Vault</h2>
            <dl className="kv">
              <dt>Base inventory (idle)</dt><dd className="num">{fmt(Number(balances[0]) / 10 ** bd)}</dd>
              <dt>Quote inventory (idle)</dt><dd className="num">{fmt(Number(balances[1]) / 10 ** qd)}</dd>
              <dt>Deployed in DLMM</dt><dd className="num">{book ? `${fmt(book.bins.reduce((s, b) => s + b.base, 0))} base · ${fmt(book.bins.reduce((s, b) => s + b.quote, 0))} quote` : "—"}</dd>
              <dt>Fee budget left</dt><dd className="num">{fmt(Number(balances[2]) / 10 ** qd)}</dd>
              <dt>Maker bond</dt><dd className="num">{fmt(Number(balances[3]) / 10 ** qd)}</dd>
              <dt>Fees earned / claimed</dt><dd className="num">{fmt(quoteUi(m.feesEarned))} / {fmt(quoteUi(m.feesClaimed))}</dd>
              {m.bondSlashed.gtn(0) && (<><dt>Bond slashed</dt><dd className="num" style={{ color: "var(--fail)" }}>{fmt(quoteUi(m.bondSlashed))}</dd></>)}
            </dl>
          </section>

          <section className="panel">
            <h2 style={{ marginBottom: 12 }}>Terms</h2>
            <dl className="kv">
              <dt>Fee per compliant period</dt><dd className="num">{fmt(quoteUi(t.feePerPeriod))}</dd>
              <dt>Period length</dt><dd>{duration(t.periodSecs)}</dd>
              <dt>Term</dt><dd>{t.durationPeriods} periods ({duration(t.periodSecs * t.durationPeriods)})</dd>
              <dt>Max spread</dt><dd>{t.maxSpreadBps} bps</dd>
              <dt>Min depth each side</dt><dd className="num">{fmt(quoteUi(t.minDepthQuote))} within ±{t.depthWindowBps / 100}%</dd>
              <dt>Allowed band</dt><dd>±{t.bandBps / 100}% of reference</dd>
              <dt>Reference price</dt><dd>DLMM TWAP over {duration(t.anchorTwapSecs)}, moves ≤ {t.anchorSpeedBpsPerMin / 100}%/min</dd>
              <dt>Liquidity lock</dt><dd>{duration(t.liquidityLockSecs)} after each deposit</dd>
              <dt>Slash after</dt><dd>{t.maxConsecutiveFailures} failed periods in a row</dd>
              <dt>Slash size</dt><dd>{t.slashBps / 100}% of bond</dd>
              <dt>DLMM pair</dt><dd className="addr">{short(m.lbPair, 6)}</dd>
              <dt>Graduated pool (DAMM v2)</dt><dd className="addr">{short(m.referencePool, 6)}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
