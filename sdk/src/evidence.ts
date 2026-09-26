/**
 * "Why was this operator paid?" — the evidence behind one scoring period, and a verifier.
 *
 * Chain of reasoning for period p of an agreement:
 *
 *   agreed terms  →  checks recorded in p  →  the rule  →  fee or failure  →  settlement
 *
 * Every check is a `SnapshotTaken` event: the Mandate program measured the operator's committed
 * liquidity inside that transaction and logged the result. Period p is closed by a
 * `PeriodFinalized` event (in whichever later transaction first crossed the period's end), which
 * records the status and the fee accrued. Fees are paid out cumulatively by `MakerFeesClaimed`
 * or at settlement (`MandateSettled`).
 *
 * What a bundle lets anyone do, and what it doesn't:
 *  - RECOMPUTED: from the terms and each check's recorded measurements, whether every check
 *    passed, the period's status, the fee, and any breach and slash. `verifyEvidence` does this
 *    with no network access.
 *  - ON CHAIN, NOT RECOMPUTED: the measurements themselves. The program computed them from the
 *    pool's accounts inside each transaction; re-measuring would need the accounts' historical
 *    state, which standard RPC doesn't serve. They are as trustworthy as the transactions.
 *  - TRUSTED: the RPC that served those transactions. The bundle lists every signature, so the
 *    CLI (scripts/explain.ts) can re-fetch them from any other RPC and compare. A hash of what
 *    one RPC returned proves nothing about whether it was truthful.
 */
import { EventParser } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { MandateClient } from "./index";

export const EVIDENCE_KIND = "mandate-evidence";

export interface EvidenceTerms {
  feePerPeriod: string;
  periodSecs: number;
  durationPeriods: number;
  bondAmount: string;
  maxSpreadBps: number;
  minDepthQuote: string;
  depthWindowBps: number;
  bandBps: number;
  maxConsecutiveFailures: number;
  slashBps: number;
}

export interface EvidenceCheck {
  sig: string;
  slot: number;
  blockTime: number | null;
  period: number;
  ok: boolean;
  spreadBps: number;
  bidDepthQuote: string;
  askDepthQuote: string;
  activeId: number;
  anchorBin: number;
  cranker: string;
}

export interface EvidenceFinalized {
  sig: string;
  slot: number;
  blockTime: number | null;
  status: 1 | 2 | 3;
  snapshots: number;
  feeAccrued: string;
}

export interface EvidencePayout {
  kind: "claim" | "settlement";
  sig: string;
  slot: number;
  blockTime: number | null;
  /** Quote paid to the operator in this transaction (all fees owed so far, not only this period's). */
  amount: string;
  /** True: the first payout after the fee accrued (it paid this fee). False: a later payout, so the fee was paid by then at the latest. */
  first: boolean;
}

export interface EvidenceBundle {
  kind: typeof EVIDENCE_KIND;
  v: 1;
  cluster: string;
  program: string;
  mandate: string;
  issuer: string;
  maker: string;
  quoteMint: string;
  quoteDecimals: number | null;
  period: number;
  /** Scoring started here (acceptance + setup window); period p covers [start + p·len, start + (p+1)·len). */
  startTs: number;
  terms: EvidenceTerms;
  /** Checks of this period found in the agreement's transaction history. */
  checks: EvidenceCheck[];
  finalized: EvidenceFinalized | null;
  /** Statuses of the periods just before this one (oldest first), for the consecutive-failure count. */
  previous: { period: number; status: number }[];
  slash: { sig: string; amount: string; consecutiveFailed: number } | null;
  payout: EvidencePayout | null;
  /** How the collector searched, so a reader knows what "not found" means. */
  search: { signaturesScanned: number; transactionsRead: number; reachedPeriodStart: boolean; note?: string };
  generatedAt: number;
  /** Where the transactions were read from (a label, never a keyed URL). */
  source: string;
}

// ------------------------------------------------------------------------------ the rule

export const STATUS_WORD: Record<number, string> = { 1: "met", 2: "failed", 3: "not checked" };
const EMPTY_SIDE = 65535;

export interface CheckVerdict {
  check: EvidenceCheck;
  bids: boolean;
  asks: boolean;
  spread: boolean;
  /** Recomputed from the recorded measurements and the terms. */
  ok: boolean;
  /** The program's own verdict agrees with the recomputation. */
  agrees: boolean;
}

export function judgeCheck(c: EvidenceCheck, t: EvidenceTerms): CheckVerdict {
  const min = BigInt(t.minDepthQuote);
  const bids = BigInt(c.bidDepthQuote) >= min;
  const asks = BigInt(c.askDepthQuote) >= min;
  const spread = c.spreadBps !== EMPTY_SIDE && c.spreadBps <= t.maxSpreadBps;
  const ok = bids && asks && spread;
  return { check: c, bids, asks, spread, ok, agrees: ok === c.ok };
}

export interface Explanation {
  window: { from: number; to: number };
  verdicts: CheckVerdict[];
  /** Checks the program recorded for the period (from its finalization), if known. */
  recordedChecks: number | null;
  /** Every recorded check was found and read. */
  complete: boolean;
  /** Status recomputed from the checks found. When incomplete, a failed check still decides "failed". */
  status: 1 | 2 | 3 | null;
  statusReason: string;
  fee: bigint;
  consecutiveFailed: number | null;
  /** The count reaches back to a met period or the first period (older statuses were available). */
  consecutiveKnown: boolean;
  breach: { slash: bigint; reached: boolean } | null;
}

/** Apply the agreement's rule to one period's evidence. Pure: no network, no clock. */
export function explainPeriod(b: EvidenceBundle): Explanation {
  const t = b.terms;
  const from = b.startTs + b.period * t.periodSecs;
  const verdicts = [...b.checks].sort((x, y) => x.slot - y.slot).map((c) => judgeCheck(c, t));
  const recordedChecks = b.finalized?.snapshots ?? null;
  const complete = recordedChecks !== null && verdicts.length === recordedChecks;
  const anyFailed = verdicts.some((v) => !v.ok);

  let status: Explanation["status"];
  let statusReason: string;
  if (anyFailed) {
    status = 2;
    statusReason = "At least one check failed, and a period is paid only if every check passes.";
  } else if (complete && verdicts.length === 0) {
    status = 3;
    statusReason = "Nobody checked this period, so it is neither paid nor counted as a failure.";
  } else if (complete) {
    status = 1;
    const n = verdicts.length;
    statusReason = `${n === 1 ? "The one check" : n === 2 ? "Both checks" : `All ${n} checks`} passed, and the period was checked at least once.`;
  } else {
    status = null;
    statusReason = recordedChecks === null ? "The period's finalization wasn't found, so the number of checks it recorded is unknown." : `Only ${verdicts.length} of the ${recordedChecks} recorded checks were found, and none of those failed.`;
  }

  const fee = status === 1 ? BigInt(t.feePerPeriod) : 0n;
  let consecutiveFailed: number | null = null;
  let consecutiveKnown = false;
  let breach: Explanation["breach"] = null;
  if (status === 2) {
    // On chain a failed period adds one, a met period resets to zero, and an unchecked period
    // leaves the count alone. Walk back over the program's recorded statuses.
    const byPeriod = new Map(b.previous.map((e) => [e.period, e.status]));
    let n = 1;
    consecutiveKnown = true;
    for (let q = b.period - 1; q >= 0; q--) {
      const st = byPeriod.get(q);
      if (st === undefined) {
        consecutiveKnown = false;
        break;
      }
      if (st === 1) break;
      if (st === 2) n++;
    }
    consecutiveFailed = n;
    const reached = n >= t.maxConsecutiveFailures;
    breach = { reached, slash: reached ? (BigInt(t.bondAmount) * BigInt(t.slashBps)) / 10_000n : 0n };
  }
  return { window: { from, to: from + t.periodSecs }, verdicts, recordedChecks, complete, status, statusReason, fee, consecutiveFailed, consecutiveKnown, breach };
}

export interface VerifyResult {
  name: string;
  pass: boolean | null;
  detail: string;
  /** recomputed: arithmetic redone here; recorded: compared against what the program logged. */
  basis: "recomputed" | "recorded";
}

/** Recompute the period's outcome from the bundle and compare it with what the program recorded. */
export function verifyEvidence(b: EvidenceBundle, money: (atoms: string | bigint) => string = (a) => String(a)): { explanation: Explanation; results: VerifyResult[]; ok: boolean } {
  if (b.kind !== EVIDENCE_KIND || b.v !== 1) throw new Error("not a Mandate evidence bundle (v1)");
  const x = explainPeriod(b);
  const results: VerifyResult[] = [];
  for (const v of x.verdicts) {
    results.push({
      name: `Check at slot ${v.check.slot}`,
      pass: v.agrees,
      basis: "recomputed",
      detail: `bids ${v.bids ? "≥" : "<"} minimum, asks ${v.asks ? "≥" : "<"} minimum, spread ${v.spread ? "within" : "outside"} the limit → ${v.ok ? "pass" : "fail"}; the program recorded ${v.check.ok ? "pass" : "fail"}`,
    });
    if (v.check.period !== b.period) results.push({ name: `Check at slot ${v.check.slot} period`, pass: false, basis: "recorded", detail: `recorded for period ${v.check.period + 1}, not ${b.period + 1}` });
  }
  results.push({
    name: "Evidence complete",
    pass: x.recordedChecks === null ? null : x.complete,
    basis: "recorded",
    detail: x.recordedChecks === null ? "the period's finalization wasn't found" : `found ${x.verdicts.length} of ${x.recordedChecks} checks the program recorded`,
  });
  if (b.finalized) {
    results.push({
      name: "Period status",
      pass: x.status === null ? null : x.status === b.finalized.status,
      basis: "recomputed",
      detail: `recomputed ${x.status === null ? "undetermined" : STATUS_WORD[x.status]}; the program recorded ${STATUS_WORD[b.finalized.status]}`,
    });
    const expectedFee = b.finalized.status === 1 ? BigInt(b.terms.feePerPeriod) : 0n;
    results.push({
      name: "Fee accrued",
      pass: BigInt(b.finalized.feeAccrued) === expectedFee,
      basis: "recomputed",
      detail: `terms give ${money(expectedFee)} for a ${STATUS_WORD[b.finalized.status]} period; the program accrued ${money(b.finalized.feeAccrued)}`,
    });
  }
  if (x.breach?.reached || b.slash) {
    results.push({
      name: "Slash",
      pass: x.breach?.reached && b.slash ? BigInt(b.slash.amount) === x.breach.slash : x.breach?.reached ? null : false,
      basis: "recomputed",
      detail: b.slash ? `recomputed ${money(x.breach?.slash ?? 0n)}; the program slashed ${money(b.slash.amount)} after ${b.slash.consecutiveFailed} failed periods in a row` : "the failure limit was reached but the slash transaction wasn't found",
    });
  }
  return { explanation: x, results, ok: results.every((r) => r.pass !== false) };
}

// ------------------------------------------------------------------------------ collection

const big = (v: any) => (v?.toString?.() ?? String(v ?? 0)) as string;
const num = (v: any) => Number(v?.toString?.() ?? v ?? 0);

export interface CollectOptions {
  cluster: string;
  source: string;
  /** Pages of 100 signatures to scan back from the newest (default 60). */
  maxPages?: number;
  /** Transactions to read after the period ends, looking for its finalization and payout (default 80). */
  maxAfter?: number;
  quoteDecimals?: number | null;
  onProgress?: (text: string) => void;
}

/**
 * Gather one period's evidence from an RPC: the agreement's terms, every transaction in the
 * period's window, and the transactions after it up to its finalization and next payout.
 */
export async function collectEvidence(conn: Connection, client: MandateClient, mandate: PublicKey, period: number, opts: CollectOptions): Promise<EvidenceBundle> {
  const info = await conn.getAccountInfo(mandate, "confirmed");
  if (!info) throw new Error("agreement not found");
  const m = client.decodeMandate(info.data);
  const t = m.terms;
  const periodSecs = num(t.periodSecs);
  const startTs = num(m.startTs);
  if (!startTs) throw new Error("this agreement hasn't started, so it has no periods");
  if (period < 0 || period >= num(t.durationPeriods)) throw new Error(`period must be between 1 and ${num(t.durationPeriods)}`);
  const from = startTs + period * periodSecs;
  const to = from + periodSecs;

  // Statuses of recent periods from the score log (the program's own record).
  const logInfo = await conn.getAccountInfo(m.scoreLog, "confirmed");
  const previous: EvidenceBundle["previous"] = [];
  let logged: { status: number; snapshots: number } | null = null;
  if (logInfo) {
    const log = client.decodeScoreLog(logInfo.data);
    const n = num(log.count);
    const len = log.entries.length;
    for (let k = 0; k < n; k++) {
      const e = log.entries[(num(log.head) - n + k + len) % len];
      const p = num(e.period);
      if (p < period && p >= period - 64) previous.push({ period: p, status: num(e.status) });
      if (p === period) logged = { status: num(e.status), snapshots: num(e.snapshots) };
    }
  }

  // Signatures, newest first, back to just before the period started.
  const say = opts.onProgress ?? (() => {});
  const sigs: { signature: string; slot: number; blockTime?: number | null; err: unknown }[] = [];
  let before: string | undefined;
  let reachedStart = false;
  const maxPages = opts.maxPages ?? 60;
  for (let page = 0; page < maxPages; page++) {
    say(`Reading the agreement's transaction list (${sigs.length} so far)…`);
    const batch = await conn.getSignaturesForAddress(mandate, { limit: 100, before }, "confirmed");
    sigs.push(...batch);
    const oldest = batch[batch.length - 1];
    if (batch.length < 100 || (oldest?.blockTime ?? Infinity) < from - 60) {
      reachedStart = true;
      break;
    }
    before = oldest.signature;
  }
  const okSigs = sigs.filter((s) => !s.err).reverse(); // oldest first
  const inWindow = okSigs.filter((s) => s.blockTime != null && s.blockTime >= from - 5 && s.blockTime < to + 5);
  const after = okSigs.filter((s) => s.blockTime != null && s.blockTime >= to);

  const parser = new EventParser(client.program.programId, client.program.coder);
  let read = 0;
  const events = async (sig: string) => {
    read++;
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (!tx?.meta?.logMessages) return { tx, evs: [] as { name: string; data: any }[] };
    const evs = [...parser.parseLogs(tx.meta.logMessages)].filter((e) => (e.data as any)?.mandate?.toBase58?.() === mandate.toBase58());
    return { tx, evs: evs as { name: string; data: any }[] };
  };

  const checks: EvidenceCheck[] = [];
  const st: { finalized: EvidenceFinalized | null; slash: EvidenceBundle["slash"]; payout: EvidencePayout | null } = { finalized: null, slash: null, payout: null };

  const take = (s: (typeof okSigs)[number], tx: any, evs: { name: string; data: any }[]) => {
    const base = { sig: s.signature, slot: tx?.slot ?? s.slot, blockTime: tx?.blockTime ?? s.blockTime ?? null };
    // A slash belongs to this period only if it directly follows this period's finalization
    // (finalization emits the breach right after the period that caused it).
    let lastFinalized: number | null = null;
    for (const e of evs) {
      const d = e.data;
      if (e.name === "snapshotTaken" && num(d.period) === period) {
        checks.push({ ...base, period, ok: !!d.ok, spreadBps: num(d.spreadBps), bidDepthQuote: big(d.bidDepthQuote), askDepthQuote: big(d.askDepthQuote), activeId: num(d.activeId), anchorBin: num(d.anchorBin), cranker: d.cranker.toBase58() });
      } else if (e.name === "periodFinalized") {
        lastFinalized = num(d.period);
        if (lastFinalized === period) st.finalized = { ...base, status: num(d.status) as 1 | 2 | 3, snapshots: num(d.snapshots), feeAccrued: big(d.feeAccrued) };
      } else if (e.name === "makerSlashed" && lastFinalized === period) {
        st.slash = { sig: s.signature, amount: big(d.amount), consecutiveFailed: num(d.consecutiveFailed) };
      } else if ((e.name === "makerFeesClaimed" || e.name === "mandateSettled") && st.finalized && !st.payout) {
        const amount = e.name === "makerFeesClaimed" ? big(d.amount) : big(d.toMakerQuote);
        if (BigInt(amount) > 0n) st.payout = { kind: e.name === "makerFeesClaimed" ? "claim" : "settlement", ...base, amount, first: true };
      }
    }
  };

  // Reads run a few at a time; results are applied in chain order.
  const readAll = async (list: typeof okSigs, label: (i: number) => string) => {
    for (let i = 0; i < list.length; i += 6) {
      say(label(i));
      const got = await Promise.all(list.slice(i, i + 6).map((s) => events(s.signature)));
      got.forEach(({ tx, evs }, k) => take(list[i + k], tx, evs));
    }
  };

  // Every transaction inside the window: all of this period's checks are there.
  await readAll(inWindow, (i) => `Reading checks in the period (${Math.min(i + 6, inWindow.length)} of ${inWindow.length})…`);

  // Then forward from the period's end: its finalization and, for a paid period, the next payout.
  const maxAfter = opts.maxAfter ?? 80;
  const seen = new Set(inWindow.map((s) => s.signature));
  const forward = after.filter((s) => !seen.has(s.signature));
  let afterRead = 0;
  while (afterRead < Math.min(maxAfter, forward.length)) {
    const f = st.finalized;
    if (f && (f.status !== 1 || st.payout)) break;
    const batch = forward.slice(afterRead, afterRead + 6);
    afterRead += batch.length;
    say(f ? `Looking for the payout of this period's fee (${afterRead})…` : `Looking for the period's finalization (${afterRead})…`);
    const got = await Promise.all(batch.map((s) => events(s.signature)));
    got.forEach(({ tx, evs }, k) => take(batch[k], tx, evs));
  }
  // A paid period whose payout is further away: the newest payout after the accrual shows the
  // fee was paid by then at the latest (every payout clears everything owed at that point).
  let latestChecked = false;
  if (st.finalized?.status === 1 && !st.payout && forward.length > afterRead) {
    latestChecked = true;
    const f = st.finalized;
    const tail = forward.slice(afterRead).slice(-24).reverse();
    for (let i = 0; i < tail.length && !st.payout; i += 6) {
      say("Looking for the latest payout…");
      const batch = tail.slice(i, i + 6);
      const got = await Promise.all(batch.map((s) => events(s.signature)));
      for (const [k, { tx, evs }] of got.entries()) {
        const e = evs.find((e) => e.name === "makerFeesClaimed" || e.name === "mandateSettled");
        const slot = tx?.slot ?? batch[k].slot;
        if (!e || slot <= f.slot) continue;
        const amount = e.name === "makerFeesClaimed" ? big(e.data.amount) : big(e.data.toMakerQuote);
        if (BigInt(amount) === 0n) continue;
        st.payout = { kind: e.name === "makerFeesClaimed" ? "claim" : "settlement", sig: batch[k].signature, slot, blockTime: tx?.blockTime ?? batch[k].blockTime ?? null, amount, first: false };
        break;
      }
    }
  }
  const { finalized, slash, payout } = st;

  const notes: string[] = [];
  if (!reachedStart) notes.push(`stopped after ${maxPages * 100} transactions without reaching the period`);
  if (logged && !finalized) notes.push(`the score log records this period as ${STATUS_WORD[logged.status] ?? "empty"} with ${logged.snapshots} checks, but its finalization transaction wasn't found`);
  if (finalized?.status === 1 && !payout) notes.push(latestChecked ? "no payout found in the transactions read after the period or among the newest ones" : "the fee hasn't been paid out yet: it stays owed to the operator until a claim or settlement");

  return {
    kind: EVIDENCE_KIND,
    v: 1,
    cluster: opts.cluster,
    program: client.program.programId.toBase58(),
    mandate: mandate.toBase58(),
    issuer: m.issuer.toBase58(),
    maker: m.maker.toBase58(),
    quoteMint: m.quoteMint.toBase58(),
    quoteDecimals: opts.quoteDecimals ?? null,
    period,
    startTs,
    terms: {
      feePerPeriod: big(t.feePerPeriod),
      periodSecs,
      durationPeriods: num(t.durationPeriods),
      bondAmount: big(t.bondAmount),
      maxSpreadBps: num(t.maxSpreadBps),
      minDepthQuote: big(t.minDepthQuote),
      depthWindowBps: num(t.depthWindowBps),
      bandBps: num(t.bandBps),
      maxConsecutiveFailures: num(t.maxConsecutiveFailures),
      slashBps: num(t.slashBps),
    },
    checks,
    finalized,
    previous,
    slash,
    payout,
    search: { signaturesScanned: sigs.length, transactionsRead: read, reachedPeriodStart: reachedStart, note: notes.join("; ") || undefined },
    generatedAt: Math.floor(Date.now() / 1000),
    source: opts.source,
  };
}
