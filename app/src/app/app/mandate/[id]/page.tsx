"use client";

import { use, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ArrowLeft, CircleAlert, Eye, RefreshCw } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { useMandateActions } from "@/lib/actions";
import { complianceOf, loadMandate, type MandateView } from "@/lib/loaders";
import { connection } from "@/lib/chain";
import { ComplianceTape, LiquidityChart, LiquidityLegend, TapeLegend } from "@/components/charts";
import { WalletButton } from "@/components/wallet";
import { Address, InfoTip, Kpi, Skeleton, StatusIcon, StatusPill, TokenPair, ago, countdown, duration, fmt, fmtFull, fmtPrice } from "@/components/ui";
import { StrategyType, binArrayIndex, dlmmInitBinArrayIx } from "../../../../../../sdk/src";

export default function MandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(id);
  } catch {
    /* invalid address */
  }
  if (!key) return <NotFound text="That is not a valid mandate address." />;
  return <MandateDetail mandateKey={key} />;
}

function NotFound({ text }: { text: string }) {
  return (
    <div className="card empty-state" style={{ marginTop: 20 }}>
      <CircleAlert />
      <span className="h3" style={{ color: "var(--ink)" }}>Mandate not found</span>
      <span className="small">{text}</span>
      <Link className="btn btn-secondary btn-sm" href="/app"><ArrowLeft />All mandates</Link>
    </div>
  );
}

function MandateDetail({ mandateKey }: { mandateKey: PublicKey }) {
  const id = mandateKey.toBase58();
  const { data, error, reload } = usePoll(async () => (await loadMandate(mandateKey)) ?? ("missing" as const), [id], 10_000);
  const now = useNow();

  if (data === null && !error) {
    return (
      <div className="stack">
        <Skeleton w={120} h={14} />
        <Skeleton w={320} h={36} />
        <Skeleton h={80} />
        <Skeleton h={120} />
        <Skeleton h={300} />
      </div>
    );
  }
  if (data === "missing") return <NotFound text="No mandate exists at this address on this cluster." />;
  if (!data) return <NotFound text={`Could not load it: ${error}`} />;
  return <Detail v={data} now={now} reload={reload} error={error} />;
}

function Detail({ v, now, reload, error }: { v: MandateView; now: number; reload: () => void; error: string | null }) {
  const { key, m, status, entries, book, balances, labels } = v;
  const t = m.terms;
  const bd = book?.baseDecimals ?? 6;
  const qd = book?.quoteDecimals ?? 6;
  const q = (x: any) => Number(x.toString()) / 10 ** qd;
  const base = labels[m.baseMint.toBase58()]?.symbol ?? "base";
  const quote = labels[m.quoteMint.toBase58()]?.symbol ?? "quote";
  const rate = complianceOf(m);
  // The on-chain period only advances when someone checks or finalizes; display the
  // period the clock is in.
  const clockPeriod = Math.min(t.durationPeriods - 1, Math.max(0, Math.floor((now - m.startTs.toNumber()) / t.periodSecs)));
  const periodEnd = m.startTs.toNumber() + (m.currentPeriod + 1) * t.periodSecs;
  const clockPeriodEnd = m.startTs.toNumber() + (clockPeriod + 1) * t.periodSecs;
  const last = m.last;
  const checked = m.snapshotsTotal > 0;
  const openToAll = (m.maker as PublicKey).equals(PublicKey.default);
  const owed = Math.max(0, Number(m.feesEarned) - Number(m.feesClaimed));
  const budgetFree = Math.max(0, Number(balances[2]) - owed);
  const feeBudgetPeriods = Math.floor(budgetFree / Math.max(1, Number(t.feePerPeriod)));
  const periodsLeft = Math.max(0, t.durationPeriods - clockPeriod - 1);

  return (
    <>
      <Link className="crumb" href="/app"><ArrowLeft />All mandates</Link>
      <div className="mandate-head">
        <div>
          <div className="mandate-title">
            <TokenPair base={m.baseMint} quote={m.quoteMint} labels={labels} size={38} />
            <StatusPill status={status} />
          </div>
          <div className="meta-line">
            <span>Mandate <Address value={key} /></span>
            <span>Issuer <Address value={m.issuer} glyph /></span>
            <span>Maker {openToAll ? <b style={{ color: "var(--ink-2)", fontWeight: 560 }}>open to any maker</b> : <Address value={m.maker} glyph />}</span>
          </div>
        </div>
        {error && <span className="xs muted">Showing the last loaded data. {error}</span>}
      </div>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Compliance" value={rate === null ? "—" : `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`} sub={`${m.periodsOk} compliant · ${m.periodsFailed} failed`} />
        <Kpi label="Term progress" value={status === "Open" ? "Not started" : status === "Active" ? `${clockPeriod + 1} / ${t.durationPeriods}` : `${t.durationPeriods} / ${t.durationPeriods}`}
          sub={status === "Active" ? `period closes in ${countdown(clockPeriodEnd - now)}` : `${duration(t.periodSecs)} periods`} />
        <Kpi label="Fees earned by maker" value={`${fmt(q(m.feesEarned))}`} sub={`${quote} · ${fmt(q(m.feesClaimed))} claimed`} />
        <Kpi label="Reference price" value={fmtPrice(book?.refUi ?? 0)} sub={`${quote} per ${base}`}
          info="Follows the pair's time-weighted oracle price at a capped speed. Bids must sit at or below it, asks at or above it." />
        <Kpi label="Maker bond" value={`${fmt(q(t.bondAmount), 0)}`} sub={m.bondSlashed.gtn(0) ? `${fmt(q(m.bondSlashed))} slashed` : `${quote} · not slashed`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="h3">Compliance history <InfoTip>Each cell is one scoring period. A period pays the maker only if it was checked and every check passed.</InfoTip></span>
          <span className="small muted">
            {status === "Active" ? `Period ${clockPeriod + 1} of ${t.durationPeriods} · closes in ${countdown(clockPeriodEnd - now)}` : status === "Open" ? "Scoring starts when a maker accepts" : `${m.periodsUnobserved} periods not observed`}
          </span>
        </div>
        <div className="card-body" style={{ display: "grid", gap: 12 }}>
          {status === "Open" ? (
            <div className="notice info">This mandate is funded and waiting for a market maker. Once one accepts and posts the bond, every {duration(t.periodSecs)} period is scored here.</div>
          ) : (
            <ComplianceTape entries={entries} live={status === "Active" ? { period: m.currentPeriod, failed: m.curFailedSnapshots > 0, snapshots: m.curSnapshots } : null}
              total={t.durationPeriods} cells={72} size="lg" quoteDecimals={qd} quoteSymbol={quote} />
          )}
          <div className="row-between wrap"><TapeLegend /><span className="xs muted">Hover a period for its details</span></div>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="h3">The vault&apos;s quotes</span>
              <div className="chart-head">
                <div className="chart-stat"><span className="k"><i className="swatch line" style={{ width: 12 }} />Reference</span><span className="v">{fmtPrice(book?.refUi ?? 0)}</span></div>
                <div className="chart-stat"><span className="k">Active price</span><span className="v">{fmtPrice(book?.activeUi ?? 0)}</span></div>
                <div className="chart-stat"><span className="k">Graduated pool <InfoTip>Price in the DAMM v2 pool the token graduated into. Shown for comparison; it is not used for enforcement because a spot price can be moved within one transaction.</InfoTip></span><span className="v">{fmtPrice(book?.dammUi ?? 0)}</span></div>
              </div>
            </div>
            <div className="card-body" style={{ display: "grid", gap: 14 }}>
              {book ? (
                <LiquidityChart bins={book.bins} refBin={book.refBin} activeBin={book.pair.activeId} binStep={book.pair.binStep} refUi={book.refUi}
                  depthWindowBps={t.depthWindowBps} quoteSymbol={quote} baseSymbol={base} height={250} />
              ) : <Skeleton h={250} />}
              <LiquidityLegend quoteSymbol={quote} windowBps={t.depthWindowBps} />
              {book && book.targetBin !== book.refBin && (
                <div className="notice subtle">
                  The time-weighted price is {book.targetBin > book.refBin ? "above" : "below"} the reference, so the reference is moving toward it at up to {t.anchorSpeedBpsPerMin / 100}% a minute.
                </div>
              )}
            </div>
          </div>

          <div className="grid-halves">
            <div className="card">
              <div className="card-head"><span className="h3">Term sheet</span><span className="xs muted">Fixed at creation</span></div>
              <div className="card-body">
                <div className="dl-group">
                  <div className="dl-title">Economics</div>
                  <dl className="dl">
                    <dt>Fee per compliant period</dt><dd>{fmtFull(q(t.feePerPeriod))} {quote}</dd>
                    <dt>Period length</dt><dd>{duration(t.periodSecs)}</dd>
                    <dt>Term</dt><dd>{t.durationPeriods} periods · {duration(t.periodSecs * t.durationPeriods)}</dd>
                  </dl>
                </div>
                <div className="dl-group">
                  <div className="dl-title">Obligations</div>
                  <dl className="dl">
                    <dt>Max spread</dt><dd>{t.maxSpreadBps} bps</dd>
                    <dt>Min liquidity each side</dt><dd>{fmtFull(q(t.minDepthQuote))} {quote}</dd>
                    <dt>Measured within</dt><dd>±{t.depthWindowBps / 100}% of reference</dd>
                    <dt>Allowed band</dt><dd>±{t.bandBps / 100}% of reference</dd>
                  </dl>
                </div>
                <div className="dl-group">
                  <div className="dl-title">Reference price</div>
                  <dl className="dl">
                    <dt>Time-weighted over</dt><dd>{duration(t.anchorTwapSecs)}</dd>
                    <dt>Max speed</dt><dd>{t.anchorSpeedBpsPerMin / 100}% per minute</dd>
                    <dt>Liquidity lock</dt><dd>{duration(t.liquidityLockSecs)} after each deposit</dd>
                  </dl>
                </div>
                <div className="dl-group">
                  <div className="dl-title">Enforcement</div>
                  <dl className="dl">
                    <dt>Maker bond</dt><dd>{fmtFull(q(t.bondAmount))} {quote}</dd>
                    <dt>Slash after</dt><dd>{t.maxConsecutiveFailures} failed periods in a row</dd>
                    <dt>Slash size</dt><dd>{t.slashBps / 100}% of the bond</dd>
                  </dl>
                </div>
              </div>
            </div>

            <div className="stack">
              <div className="card">
                <div className="card-head"><span className="h3">Vault</span><span className="xs muted">Program-owned</span></div>
                <div className="card-body">
                  <dl className="dl">
                    <dt>Deployed in DLMM</dt>
                    <dd>{book ? <span style={{ display: "grid" }}><span>{fmt(book.bins.reduce((s, b) => s + b.base, 0))} {base}</span><span>{fmt(book.bins.reduce((s, b) => s + b.quote, 0))} {quote}</span></span> : "—"}</dd>
                    <dt>Idle in vault</dt>
                    <dd><span style={{ display: "grid" }}><span>{fmt(Number(balances[0]) / 10 ** bd)} {base}</span><span>{fmt(Number(balances[1]) / 10 ** qd)} {quote}</span></span></dd>
                    <dt>Fee budget</dt>
                    <dd><span style={{ display: "grid" }}><span>{fmt(budgetFree / 10 ** qd)} {quote} free</span>{owed > 0 && <span className="xs muted" style={{ fontWeight: 450 }}>+ {fmt(owed / 10 ** qd)} owed to the maker</span>}</span></dd>
                    <dt>Budget covers</dt><dd style={{ color: status === "Active" && feeBudgetPeriods < periodsLeft ? "var(--warn)" : undefined }}>{status === "Active" ? `${Math.min(feeBudgetPeriods, periodsLeft)} of ${periodsLeft} remaining periods` : `${feeBudgetPeriods} periods`}</dd>
                    <dt>Bond held</dt><dd>{fmt(Number(balances[3]) / 10 ** qd)} {quote}</dd>
                  </dl>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><span className="h3">Accounts</span></div>
                <div className="card-body">
                  <dl className="dl">
                    <dt>DLMM pair</dt><dd><Address value={m.lbPair} /></dd>
                    <dt>Oracle</dt><dd><Address value={m.oracle} /></dd>
                    <dt>Graduated pool</dt><dd><Address value={m.referencePool} /></dd>
                    <dt>Position</dt><dd>{(m.position as PublicKey).equals(PublicKey.default) ? <span className="muted">none</span> : <Address value={m.position} />}</dd>
                    <dt>Base vault</dt><dd><Address value={m.baseVault} /></dd>
                    <dt>Quote vault</dt><dd><Address value={m.quoteVault} /></dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="stack sticky">
          <div className="card">
            <div className="card-head">
              <span className="h3">Latest check</span>
              <span className="xs muted">{checked ? `${ago(now - last.ts.toNumber())} · ${m.snapshotsTotal} total` : "Not checked yet"}</span>
            </div>
            <div className="card-body">
              <div className="checks">
                <CheckRow name="Spread" pass={checked ? last.spreadBps <= t.maxSpreadBps : null}
                  value={checked ? (last.spreadBps === 65535 ? "One side empty" : `${last.spreadBps} bps`) : "—"}
                  target={`max ${t.maxSpreadBps} bps, at a size of ${fmt(q(t.minDepthQuote) / 10)} ${quote}`}
                  fill={checked && last.spreadBps !== 65535 ? Math.min(1, last.spreadBps / Math.max(1, t.maxSpreadBps)) : 1} lowerIsBetter />
                <CheckRow name="Bids committed" pass={checked ? last.bidDepthQuote.gte(t.minDepthQuote) : null}
                  value={checked ? `${fmt(q(last.bidDepthQuote))} ${quote}` : "—"}
                  target={`min ${fmt(q(t.minDepthQuote))} within ${t.depthWindowBps / 100}% below the reference`}
                  fill={checked ? Math.min(1, q(last.bidDepthQuote) / Math.max(1e-9, q(t.minDepthQuote))) : 0} />
                <CheckRow name="Asks committed" pass={checked ? last.askDepthQuote.gte(t.minDepthQuote) : null}
                  value={checked ? `${fmt(q(last.askDepthQuote))} ${quote}` : "—"}
                  target={`min ${fmt(q(t.minDepthQuote))} within ${t.depthWindowBps / 100}% above the reference`}
                  fill={checked ? Math.min(1, q(last.askDepthQuote) / Math.max(1e-9, q(t.minDepthQuote))) : 0} />
              </div>
            </div>
            <div className="card-foot" style={{ display: "grid", gap: 8 }}>
              <SnapshotButton v={v} reload={reload} />
              <span className="xs muted">Anyone can check the maker at any time, as often as they like. Trading against the position can&apos;t change the result.</span>
            </div>
          </div>
          <ActionsCard v={v} now={now} reload={reload} periodEnd={periodEnd} />
        </div>
      </div>
    </>
  );
}

/** One obligation with its measured value, the target, and a meter (spread: share of the allowed maximum used; depth: share of the minimum met). */
function CheckRow({ name, pass, value, target, fill }: { name: string; pass: boolean | null; value: string; target: string; fill: number; lowerIsBetter?: boolean }) {
  return (
    <div className="check">
      <span className="check-name"><StatusIcon pass={pass} />{name}</span>
      <span className="check-value">{value}</span>
      <span className="check-target">{target}</span>
      <span className={`meter ${pass === false ? "fail" : ""}`} aria-hidden="true">
        <span style={{ width: `${Math.max(2, fill * 100)}%` }} />
      </span>
    </div>
  );
}

function SnapshotButton({ v, reload }: { v: MandateView; reload: () => void }) {
  const { run, busy, me } = useMandateActions();
  const active = v.status === "Active";
  if (!me) return <WalletButton />;
  return (
    <button className="btn btn-secondary btn-block" disabled={!active || !!busy}
      onClick={() => run("Check", async (c, me) => [await c.snapshot({ cranker: me, mandate: v.key, m: v.m })], { done: "Check recorded on-chain." }).then(() => setTimeout(reload, 500))}>
      <RefreshCw />
      {busy === "Check" ? "Checking…" : active ? "Check the maker now" : "Checks run while the mandate is active"}
    </button>
  );
}

function ActionsCard({ v, now, reload, periodEnd }: { v: MandateView; now: number; reload: () => void; periodEnd: number }) {
  const { me, run, busy } = useMandateActions();
  const [pct, setPct] = useState(90);
  const [halfWidth, setHalfWidth] = useState(8);
  const { key, m, status, book, balances } = v;
  const t = m.terms;
  const qd = book?.quoteDecimals ?? 6;
  const isMaker = !!me && (m.maker as PublicKey).equals(me);
  const isIssuer = !!me && (m.issuer as PublicKey).equals(me);
  const openToAll = (m.maker as PublicKey).equals(PublicKey.default);
  const hasPosition = !(m.position as PublicKey).equals(PublicKey.default);
  const earned = (Number(m.feesEarned) - Number(m.feesClaimed)) / 10 ** qd;
  const after = () => setTimeout(reload, 500);

  const accept = () =>
    run("Accept", async (c, me) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, me, true), me, m.quoteMint),
      await c.accept({ maker: me, mandate: key, m }),
    ], { done: "Mandate accepted. Your bond is posted and scoring has started." }).then(after);
  const cancel = () => run("Cancel", async (c) => [await c.cancel({ mandate: key, m })], { done: "Mandate cancelled. Funds returned to you." }).then(after);
  const finalize = () => run("Finalize", async (c) => [await c.finalize({ mandate: key, m })], { done: "Elapsed periods finalized." }).then(after);
  const openPosition = () =>
    run("Open position", async (c, me) => {
      const lower = book!.refBin - 35;
      const ixs = [];
      for (let i = binArrayIndex(lower); i <= binArrayIndex(lower + 69); i++) ixs.push(dlmmInitBinArrayIx(m.lbPair, i, me));
      const infos = await connection().getMultipleAccountsInfo(ixs.map((ix) => ix.keys[1].pubkey));
      return [...ixs.filter((_, i) => !infos[i]), await c.openPosition({ maker: me, mandate: key, m, lowerBinId: lower, width: 70 })];
    }, { done: "Position opened around the reference price." }).then(after);
  const deploy = () =>
    run("Deploy", async (c, me) => {
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
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(0), amountQuote: new BN(((balances[1] * f) / 100n).toString()), minBinId: lo, maxBinId: bidMax, strategy: StrategyType.SpotImBalanced }));
      const askMin = Math.max(ref, pair.activeId, lo);
      if (balances[0] > 0n && askMin <= hi)
        ixs.push(await c.addLiquidity({ authority: me, mandate: key, m, pair, amountBase: new BN(((balances[0] * f) / 100n).toString()), amountQuote: new BN(0), minBinId: askMin, maxBinId: hi, strategy: StrategyType.SpotImBalanced }));
      if (!ixs.length) throw new Error("Nothing to deploy: the vault is empty or no bins are allowed right now.");
      return ixs;
    }, { done: "Inventory deployed as bids and asks around the reference." }).then(after);
  const pull = (close: boolean) =>
    run(close ? "Unwind" : "Withdraw", async (c, me) => {
      const ixs = [await c.removeLiquidity({ authority: me, mandate: key, m, pair: book!.pair })];
      if (close) ixs.push(await c.closePosition({ authority: me, mandate: key, m }));
      return ixs;
    }, { done: close ? "Liquidity returned to the vault and the position closed." : "Liquidity returned to the vault." }).then(after);
  const claim = () => run("Claim", async (c) => [await c.claimMakerFees({ mandate: key, m })], { done: "Earned fees sent to your wallet." }).then(after);
  const settle = () =>
    run("Settle", async (c, me) => [
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.baseMint, m.issuer, true), m.issuer, m.baseMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.issuer, true), m.issuer, m.quoteMint),
      createAssociatedTokenAccountIdempotentInstruction(me, getAssociatedTokenAddressSync(m.quoteMint, m.maker, true), m.maker, m.quoteMint),
      await c.settle({ mandate: key, m }),
    ], { done: "Mandate settled and funds distributed." }).then(after);

  const role = isIssuer ? "issuer" : isMaker ? "maker" : "observer";
  const b = !!busy;

  return (
    <div className="card">
      <div className="card-head">
        <span className="h3">Actions</span>
        {me && <span className="tag">{role === "observer" ? <><Eye />Observer</> : role === "issuer" ? "You are the issuer" : "You are the maker"}</span>}
      </div>
      <div className="card-body" style={{ display: "grid", gap: 12 }}>
        {!me && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Connect a wallet to accept this mandate, manage its liquidity, or settle it. Checking and settlement are open to everyone.</p>
            <WalletButton />
          </>
        )}

        {me && status === "Open" && isIssuer && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Waiting for a market maker. You can cancel and recover everything until one accepts.</p>
            <button className="btn btn-danger" onClick={cancel} disabled={b}>Cancel mandate</button>
          </>
        )}
        {me && status === "Open" && !isIssuer && (openToAll || isMaker) && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Accepting posts a bond of <b style={{ color: "var(--ink)" }}>{fmtFull(Number(t.bondAmount) / 10 ** qd)}</b> and starts a {t.durationPeriods}-period term. You earn {fmtFull(Number(t.feePerPeriod) / 10 ** qd)} per compliant period.
            </p>
            <button className="btn btn-primary" onClick={accept} disabled={b}>Accept and post bond</button>
          </>
        )}
        {me && status === "Open" && !isIssuer && !openToAll && !isMaker && (
          <p className="small muted" style={{ margin: 0 }}>This mandate is reserved for a designated market maker.</p>
        )}

        {me && status === "Active" && isMaker && !hasPosition && (
          <>
            <p className="small muted" style={{ margin: 0 }}>Open the mandate&apos;s DLMM position around the reference price, then deploy the vault&apos;s inventory into it.</p>
            <button className="btn btn-primary" onClick={openPosition} disabled={b}>Open DLMM position</button>
          </>
        )}
        {me && status === "Active" && isMaker && hasPosition && (
          <>
            <div className="form-grid">
              <label className="field"><span className="field-label">Share of idle inventory</span>
                <span className="input-wrap"><input className="input has-suffix" type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} /><span className="input-suffix">%</span></span>
              </label>
              <label className="field"><span className="field-label">Bins each side</span>
                <input className="input" type="number" min={1} max={34} value={halfWidth} onChange={(e) => setHalfWidth(Number(e.target.value))} />
              </label>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={deploy} disabled={b} style={{ flex: 1 }}>Deploy inventory</button>
              <button className="btn btn-secondary" onClick={() => pull(false)} disabled={b}>Withdraw</button>
            </div>
            <span className="xs muted">Bids go at or below the reference and asks at or above it. Withdrawn liquidity returns to the vault, never to your wallet.</span>
          </>
        )}
        {me && status === "Active" && !isMaker && (
          <p className="small muted" style={{ margin: 0 }}>
            {isIssuer ? "Your inventory is under the maker's management for the term. " : ""}You can check the maker at any time; periods finalize automatically on the next check.
          </p>
        )}
        {me && isMaker && earned > 0 && (
          <button className="btn btn-secondary" onClick={claim} disabled={b}>Claim {fmt(earned)} in earned fees</button>
        )}
        {me && status === "Active" && now >= periodEnd && (
          <button className="btn btn-secondary" onClick={finalize} disabled={b}>Finalize elapsed periods</button>
        )}
        {me && (status === "Breached" || status === "Expired") && (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              {status === "Breached" ? "The maker breached the terms. " : "The term has ended. "}Anyone can unwind the position and distribute the funds.
            </p>
            {hasPosition
              ? <button className="btn btn-primary" onClick={() => pull(true)} disabled={b}>Unwind liquidity</button>
              : <button className="btn btn-primary" onClick={settle} disabled={b}>Settle and distribute</button>}
          </>
        )}
        {me && (status === "Settled" || status === "Cancelled") && <p className="small muted" style={{ margin: 0 }}>This mandate is closed. All funds have been returned.</p>}
        {busy && <span className="xs muted">{busy}: waiting for confirmation…</span>}
      </div>
    </div>
  );
}
