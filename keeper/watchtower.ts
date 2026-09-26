/**
 * A watchtower with a sentinel. Enforcement only works on periods somebody observes, so the
 * observing is built as its own reliable service, and the model can never slow it down:
 *
 *   - Checks run on a deadline-driven schedule: every active SLA gets at least one check per
 *     period (a check is forced as the period nears its end), spare checks go where the rules
 *     say the next check is likely to fail, and draws stay random so makers can't predict them.
 *     Checks, catch-up and settlement run with bounded concurrency; one failing SLA doesn't
 *     hold up the others, and every send has a deadline.
 *   - A System One model (Jev by default) runs in its own bounded queue, with a timeout and a
 *     circuit breaker, on observations that are already confirmed on chain. Its read is bound
 *     to that observation (and expires); a check never waits for it.
 *   - Each check carries the latest read of the previous check as an SPL Memo signed by the
 *     watchtower (see sdk/src/sentinel.ts): the rules' read, combined with the model's when
 *     the model has assessed exactly that observation.
 *   - Maker activity comes from the program's own events, read page by page back to a saved
 *     cursor, checked against the mandate it names; transactions not available yet are kept
 *     and retried, and the history is marked incomplete until they resolve.
 *
 * State (cursors, unresolved transactions, checks, reads) is kept in a durable store, so a
 * restart resumes. Enforcement is untouched: the program measures, pays and slashes alone.
 */
import { EventParser } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { MANDATE_PROGRAM_ID, MEMO_PROGRAM_ID, MandateClient, decodeLbPair, loadAccounts, pda, statusName } from "../sdk/src";
import { encodeSentinelMemo, inputHash, SENTINEL_POLICY, type PublishedRead } from "../sdk/src/sentinel";
import type { SystemOneConfig } from "../sdk/src/systemone";
import { redact } from "../sdk/src/rpc";
import { chainTime, fetchMandate, fetchMandates, sendIxs } from "./common";
import { catchUp, closeOut, eachLimit, periodsBehind } from "./lifecycle";
import { assessWithModel, assessWithRules, combine, RULES_CONFIDENT, type Assessment, type Observation } from "./sentinel";
import { KeeperStore, type MandateRecord, type ModelRead } from "./store";

export interface WatchOptions {
  /** Baseline random checks per period for an SLA with no signs of trouble. */
  samplesPerPeriod?: number;
  /** Check more often where the next check is likely to fail. */
  riskWeighted?: boolean;
  /** Decision model for the diagnosis and outlooks; null for rules only. */
  sentinel?: SystemOneConfig | null;
  /** Cap on checks per minute across every SLA (a watchtower's fee and RPC budget). Coverage-deadline checks always run. */
  budgetPerMinute?: number;
  /** Minimum seconds between model reads for one SLA, unless its situation changes. */
  modelEverySecs?: number;
  /** Where to keep durable state; null keeps it in memory only. */
  stateFile?: string | null;
  /** Checks in flight at once. */
  checkConcurrency?: number;
  /** Token symbol for a mint (base or quote), for what the model reads and the logs. */
  symbolOf?: (mint: PublicKey) => string | undefined;
  onEvent?: (mandate: string, what: string, detail?: { assessment?: Assessment; ok?: boolean; m?: any }) => void | Promise<void>;
}

/**
 * Seconds until an SLA's next check: uniform on [0, 2 × mean], so checks stay unpredictable,
 * with the mean shrinking from period/samples toward a fifth of it as the failure risk grows.
 */
export function checkGap(periodSecs: number, risk: number, samplesPerPeriod = 3, riskWeighted = true, rand = Math.random) {
  const mean = (periodSecs / samplesPerPeriod) * (riskWeighted ? 1 - 0.8 * Math.min(1, Math.max(0, risk)) : 1);
  return rand() * 2 * mean;
}

/** A period with no check yet gets one forced when this little time is left (a quarter of the period, at least 20 s). */
export function coverageDeadline(periodSecs: number) {
  return Math.max(20, periodSecs / 4);
}

// ---------------------------------------------------------------- model worker

interface ModelJob {
  key: string;
  obs: Observation;
  observedTs: number;
  hash: string;
  periodSecs: number;
}

/**
 * Runs model calls off the checking path: at most `concurrency` at once, one queued job per
 * SLA (a newer observation replaces an older queued one), each with its own timeout. After
 * `trip` failures in a row it stops calling for `coolMs`. Results land in the store.
 */
export class ModelWorker {
  private queue = new Map<string, ModelJob>();
  private running = 0;
  private failures = 0;
  private openUntil = 0;
  stats = { calls: 0, ok: 0, failed: 0, skippedOpen: 0 };

  constructor(private cfg: SystemOneConfig, private store: KeeperStore, private opts: { concurrency?: number; timeoutMs?: number; trip?: number; coolMs?: number } = {}) {}

  get open() {
    return Date.now() < this.openUntil;
  }

  submit(job: ModelJob) {
    const prev = this.store.get(job.key).model;
    if (prev && prev.observedTs === job.observedTs && prev.inputHash === job.hash) return;
    if (this.open) return void this.stats.skippedOpen++;
    this.queue.set(job.key, job);
    this.pump();
  }

  private pump() {
    while (this.running < (this.opts.concurrency ?? 2) && this.queue.size) {
      const [key, job] = this.queue.entries().next().value!;
      this.queue.delete(key);
      this.running++;
      this.stats.calls++;
      assessWithModel({ ...this.cfg, timeoutMs: this.opts.timeoutMs ?? 8_000 }, job.obs)
        .then((a) => {
          this.failures = 0;
          this.stats.ok++;
          const now = Math.floor(Date.now() / 1000);
          const read: ModelRead = {
            observedTs: job.observedTs,
            inputHash: job.hash,
            assessedAt: now,
            expiresAt: now + Math.max(60, Math.min(job.periodSecs, 600)),
            a: { breach: a.breach, diagnosis: a.diagnosis, confidence: a.confidence, noRedeploy: a.noRedeploy, source: a.source, latencyMs: a.latencyMs },
          };
          const rec = this.store.get(key);
          if (!rec.model || rec.model.observedTs <= job.observedTs) rec.model = read;
        })
        .catch(() => {
          this.stats.failed++;
          if (++this.failures >= (this.opts.trip ?? 3)) (this.openUntil = Date.now() + (this.opts.coolMs ?? 60_000)), (this.failures = 0);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Resolves when nothing is queued or running (for scripts and tests). */
  async idle(maxMs = 30_000) {
    const until = Date.now() + maxMs;
    while ((this.running || this.queue.size) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------- watchtower

const MAX_ACTIVITY = 20;
const MAX_SEEN = 400;
const MAX_PAGES = 10;
const FIRST_PAGE = 25;
const MAX_UNRESOLVED_TRIES = 30;

interface Live {
  pubkey: PublicKey;
  key: string;
  m: any;
  profile: any | null;
}

export class Watchtower {
  readonly store: KeeperStore;
  readonly model: ModelWorker | null;
  private next = new Map<string, number>();
  private riskOf = new Map<string, number>();
  private readAt = new Map<string, number>();
  private list = { at: 0, keys: [] as PublicKey[] };
  private binSteps = new Map<string, number>();
  private decimals = new Map<string, number>();
  private spent: number[] = [];
  private parser: EventParser;
  private warnedCapacity = false;

  constructor(private conn: Connection, private me: Keypair, private client: MandateClient, private opts: WatchOptions = {}) {
    this.parser = new EventParser(MANDATE_PROGRAM_ID, client.program.coder);
    this.store = new KeeperStore(opts.stateFile ?? null);
    this.model = opts.sentinel ? new ModelWorker(opts.sentinel, this.store) : null;
  }

  /** The latest model read and recorded checks per SLA (for logs and tests). */
  latest(mandate: string) {
    if (!this.store.has(mandate)) return null;
    const rec = this.store.get(mandate);
    return { model: rec.model ?? null, checks: rec.checks };
  }

  private emit(key: string, what: string, detail?: Parameters<NonNullable<WatchOptions["onEvent"]>>[2]) {
    return Promise.resolve(this.opts.onEvent?.(key, redact(what), detail)).catch(() => undefined);
  }

  /** Every mandate still worth watching: discovered once a minute, refreshed in chunks in between. */
  private async mandates(): Promise<{ pubkey: PublicKey; m: any }[]> {
    const ended = (m: any) => ["Settled", "Cancelled"].includes(statusName(m.status));
    if (Date.now() - this.list.at > 60_000) {
      const all = (await fetchMandates(this.conn, this.client)).filter((x) => !ended(x.m));
      this.list = { at: Date.now(), keys: all.map((x) => x.pubkey) };
      this.store.retain(new Set(this.list.keys.map((k) => k.toBase58())));
      return all;
    }
    const { infos } = await loadAccounts(this.conn, this.list.keys, { partial: true });
    return this.list.keys.flatMap((pubkey, i) => (infos[i] ? [{ pubkey, m: this.client.decodeMandate(infos[i]!.data) }] : [])).filter((x) => !ended(x.m));
  }

  /** Raw token amount in UI units, using the mint's real decimals (never assumed). */
  private amount(raw: any, mint: PublicKey) {
    const d = this.decimals.get(mint.toBase58());
    if (d === undefined) throw new Error(`decimals unknown for ${mint.toBase58()}`);
    return Number(raw) / 10 ** d;
  }

  private symbol(mint: PublicKey, fallback: string) {
    return this.opts.symbolOf?.(mint) ?? fallback;
  }

  /**
   * The maker's verified liquidity actions on this SLA, from the program's events. Pages back
   * to the saved cursor; transactions that aren't available yet are retried later, and the
   * history counts as complete only when nothing relevant is missing.
   */
  private async readActivity(key: PublicKey, m: any, rec: MandateRecord, now: number) {
    const id = key.toBase58();
    const listed: { signature: string; err: unknown; blockTime?: number | null }[] = [];
    let before: string | undefined;
    let reachedCursor = false;
    // The first read takes one short page (older history is a recorded gap, which ages out of
    // the rules' horizon); later reads page back to the cursor.
    const limit = rec.cursor ? 100 : FIRST_PAGE;
    for (let page = 0; page < (rec.cursor ? MAX_PAGES : 1); page++) {
      const sigs = await this.conn.getSignaturesForAddress(key, { limit, before, until: rec.cursor }, "confirmed");
      listed.push(...sigs);
      if (sigs.length < limit) {
        reachedCursor = true;
        break;
      }
      before = sigs[sigs.length - 1].signature;
    }
    if (!reachedCursor && listed.length) {
      // More pages since the cursor than we read: everything older is a known gap.
      rec.gapBefore = Math.max(rec.gapBefore, listed[listed.length - 1].blockTime ?? now);
    }
    const unresolved = new Map(rec.unresolved.map((u) => [u.sig, u]));
    const queue = [...new Set([...rec.unresolved.map((u) => u.sig), ...listed.filter((s) => !s.err).map((s) => s.signature).reverse()])];
    for (const sig of queue) {
      const tx = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => undefined);
      if (!tx) {
        // Not available yet at this commitment (null), or the read failed: keep it and retry.
        const u = unresolved.get(sig) ?? { sig, tries: 0, firstSeen: now };
        u.tries++;
        if (u.tries > MAX_UNRESOLVED_TRIES) {
          unresolved.delete(sig);
          rec.gapBefore = Math.max(rec.gapBefore, u.firstSeen);
        } else unresolved.set(sig, u);
        continue;
      }
      unresolved.delete(sig);
      if (tx.meta?.err || !tx.meta?.logMessages) continue;
      const ts = tx.blockTime ?? now;
      const q = this.symbol(m.quoteMint, "quote");
      const b = this.symbol(m.baseMint, "tokens");
      const n = (v: any, mint: PublicKey) => Math.round(this.amount(v, mint)).toLocaleString("en-US");
      let j = 0;
      for (const ev of this.parser.parseLogs(tx.meta.logMessages)) {
        const evId = `${sig}:${j++}`;
        const d = ev.data as any;
        // Only events this program emitted about this mandate (a transaction can touch several).
        if (d?.mandate?.toBase58?.() !== id || rec.seen.includes(evId)) continue;
        rec.seen.push(evId);
        // Liquidity and fee events on an active mandate can only come from its maker (the
        // program checks the signer), whoever paid the transaction fee.
        let action: string | null = null;
        if (ev.name === "liquidityDeployed") {
          const parts = [Number(d.amountQuote) > 0 ? `${n(d.amountQuote, m.quoteMint)} ${q} of bids` : "", Number(d.amountBase) > 0 ? `${n(d.amountBase, m.baseMint)} ${b} of asks` : ""].filter(Boolean);
          action = `placed ${parts.join(" and ")} near the reference price`;
        } else if (ev.name === "liquidityWithdrawn") {
          const bps = Number(d.bps);
          action = bps >= 10_000 ? "withdrew all of its liquidity back to escrow" : `withdrew ${bps / 100}% of its liquidity back to escrow`;
        } else if (ev.name === "makerFeesClaimed") action = `collected ${n(d.amount, m.quoteMint)} ${q} of earned fees`;
        if (action) rec.activity.push({ ts, action, id: evId });
      }
    }
    rec.unresolved = [...unresolved.values()];
    rec.activity.sort((a, b) => b.ts - a.ts);
    rec.activity.length = Math.min(rec.activity.length, MAX_ACTIVITY);
    if (rec.seen.length > MAX_SEEN) rec.seen = rec.seen.slice(-MAX_SEEN);
    // Every listed signature is now read or queued as unresolved, so the cursor can move.
    if (listed.length) rec.cursor = listed[0].signature;
    this.readAt.set(id, Date.now());
  }

  private syncChecks(rec: MandateRecord, m: any) {
    const l = m.last;
    const ts = l.ts.toNumber();
    if (ts > 0 && ts >= m.startTs.toNumber() && ts > (rec.checks[0]?.ts ?? 0)) {
      rec.checks.unshift({
        ts,
        ok: !!l.ok,
        bids: this.amount(l.bidDepthQuote, m.quoteMint),
        asks: this.amount(l.askDepthQuote, m.quoteMint),
        spreadBps: l.spreadBps === 65535 ? null : l.spreadBps,
        referenceBin: l.anchorBin,
      });
      rec.checks.length = Math.min(rec.checks.length, 8);
    }
  }

  private observe(x: Live, rec: MandateRecord, now: number): Observation {
    const { m, profile: p } = x;
    const t = m.terms;
    const binStep = this.binSteps.get(m.lbPair.toBase58()) ?? 10;
    const open = !(m.position as PublicKey).equals(PublicKey.default);
    const pct = (b: number) => (Math.pow(1 + binStep / 10_000, b - m.anchor.bin) - 1) * 100;
    const lower = m.positionLowerBinId as number;
    const upper = lower + (m.positionWidth as number) - 1;
    const quote = this.symbol(m.quoteMint, "quote");
    return {
      pair: `${this.symbol(m.baseMint, "the token")}/${quote}`,
      quote,
      terms: { minDepth: this.amount(t.minDepthQuote, m.quoteMint), windowPct: t.depthWindowBps / 100, maxSpreadBps: t.maxSpreadBps, periodSecs: t.periodSecs, maxFailures: t.maxConsecutiveFailures, binStep },
      scoringAgoSecs: now - m.startTs.toNumber(),
      checks: rec.checks.map((c) => ({ ...c, agoSecs: Math.max(0, now - c.ts) })),
      failedPeriodsInARow: m.consecutiveFailed,
      makerActivity: rec.activity.map((a) => ({ agoSecs: Math.max(0, now - a.ts), action: a.action })),
      // Complete only once read, with nothing unresolved and no known gap inside the window the rules look at.
      activityComplete: this.readAt.has(x.key) && rec.unresolved.length === 0 && rec.gapBefore <= now - 3 * (t.periodSecs as number),
      position: open ? { open, lowerPct: pct(lower), upperPct: pct(upper + 1) } : { open: false },
      // With no position open, everything is back in escrow; an open position's split isn't read here.
      escrowIdleShare: !open ? 1 : null,
      record: p ? { periodsMet: Number(p.periodsOk), periodsScored: Number(p.periodsOk) + Number(p.periodsFailed), breaches: p.mandatesBreached, agreements: p.mandatesAccepted } : null,
    };
  }

  /** The facts a read depends on, without clock-relative values, so the same facts hash the same. */
  private facts(x: Live, rec: MandateRecord, o: Observation) {
    return {
      key: x.key,
      policy: SENTINEL_POLICY,
      observedTs: x.m.last.ts.toNumber(),
      start: x.m.startTs.toNumber(),
      checks: rec.checks,
      activity: rec.activity.map((a) => [a.ts, a.action]),
      complete: o.activityComplete,
      position: o.position,
      streak: o.failedPeriodsInARow,
      record: o.record,
    };
  }

  private budgetLeft() {
    const cap = this.opts.budgetPerMinute;
    if (!cap) return Infinity;
    const cutoff = Date.now() - 60_000;
    this.spent = this.spent.filter((t) => t > cutoff);
    return cap - this.spent.length;
  }

  /** The read published with the next check: of the latest recorded check, never an older one. */
  private async readFor(x: Live, rec: MandateRecord, o: Observation, now: number): Promise<{ read: PublishedRead; a: Assessment } | null> {
    const observedTs = x.m.last.ts.toNumber();
    if (!observedTs || observedTs < x.m.startTs.toNumber()) return null;
    const hash = await inputHash(this.facts(x, rec, o));
    const rules = assessWithRules(o);
    const model = rec.model && rec.model.observedTs === observedTs && rec.model.inputHash === hash && now < rec.model.expiresAt ? rec.model : null;
    const a = combine(rules, model ? { ...model.a, risk: rules.risk, diagnosis: model.a.diagnosis as Assessment["diagnosis"] } : null);
    const assessedAt = Math.max(model ? model.assessedAt : now, observedTs);
    const period = x.m.terms.periodSecs as number;
    return {
      a,
      read: {
        ...a,
        mandate: x.key,
        observedTs,
        assessedAt,
        expiresAt: model ? model.expiresAt : assessedAt + Math.max(60, Math.min(period, 600)),
        policy: SENTINEL_POLICY,
        inputHash: hash,
      },
    };
  }

  /** After a check lands: queue a model read of the new observation, if it's worth one. */
  private async queueModel(x: Live, rec: MandateRecord, o: Observation, now: number) {
    if (!this.model || !rec.checks.length) return;
    const rules = assessWithRules(o);
    const last = rec.model;
    const changed = !last || last.a.diagnosis !== rules.diagnosis;
    const due = !last || now - last.assessedAt >= (this.opts.modelEverySecs ?? 45);
    if (!(changed || due || rules.confidence < RULES_CONFIDENT)) return;
    this.model.submit({ key: x.key, obs: o, observedTs: x.m.last.ts.toNumber(), hash: await inputHash(this.facts(x, rec, o)), periodSecs: x.m.terms.periodSecs });
  }

  async tick() {
    const now = await chainTime(this.conn);
    const all = await this.mandates();
    const live = all.filter((x) => statusName(x.m.status) === "Active");
    const samples = this.opts.samplesPerPeriod ?? 3;
    const weighted = this.opts.riskWeighted !== false;

    // One chunked read for every live SLA's maker profile, plus pairs and mints not cached yet.
    const profiles = live.map(({ m }) => pda.makerProfile(m.maker));
    const pairs = [...new Set(live.map(({ m }) => m.lbPair.toBase58()))].filter((k) => !this.binSteps.has(k));
    const mints = [...new Set(live.flatMap(({ m }) => [m.baseMint.toBase58(), m.quoteMint.toBase58()]))].filter((k) => !this.decimals.has(k));
    const extra = await loadAccounts(this.conn, [...profiles, ...[...pairs, ...mints].map((k) => new PublicKey(k))], { partial: true });
    const profileInfo = extra.infos.slice(0, profiles.length);
    pairs.forEach((k, i) => {
      const info = extra.infos[profiles.length + i];
      if (info) this.binSteps.set(k, decodeLbPair(info.data).binStep);
    });
    mints.forEach((k, i) => {
      const info = extra.infos[profiles.length + pairs.length + i];
      if (info && info.data.length >= 45) this.decimals.set(k, info.data[44]);
    });

    // Capacity: the coverage floor must fit the budget, or it will be exceeded to keep coverage.
    const floorPerMin = live.reduce((s, { m }) => s + 60 / (m.terms.periodSecs as number), 0);
    if (this.opts.budgetPerMinute && floorPerMin > this.opts.budgetPerMinute && !this.warnedCapacity) {
      this.warnedCapacity = true;
      await this.emit("*", `capacity: one check per period needs ${floorPerMin.toFixed(1)} checks/min, over the budget of ${this.opts.budgetPerMinute}`);
    }

    // Catch up and read activity per SLA, several at a time; one SLA's failure is its own.
    const ready: Live[] = [];
    await eachLimit(live.map((x, i) => ({ ...x, key: x.pubkey.toBase58(), profile: profileInfo[i] ? this.client.decodeMakerProfile(profileInfo[i]!.data) : null })), 4, async (x) => {
      if (!this.decimals.has(x.m.quoteMint.toBase58()) || !this.decimals.has(x.m.baseMint.toBase58())) return; // mint unread: try next tick
      const rec = this.store.get(x.key);
      try {
        if (periodsBehind(x.m, now) > 1) {
          const r = await catchUp(this.conn, this.me, this.client, x.pubkey, x.m, now);
          x.m = r.m;
          if (r.calls) await this.emit(x.key, `caught up on missed periods (${periodsBehind(x.m, now)} left)`);
          if (statusName(x.m.status) !== "Active") return;
        }
        if (Date.now() - (this.readAt.get(x.key) ?? 0) > 15_000) await this.readActivity(x.pubkey, x.m, rec, now);
      } catch (e: any) {
        await this.emit(x.key, `error: ${e.message?.split("\n")[0] ?? e}`);
      }
      this.syncChecks(rec, x.m);
      ready.push(x);
    });

    // Triage with the rules; collect what is due: coverage deadlines first, then by risk.
    const due: { x: Live; rec: MandateRecord; o: Observation; risk: number; urgent: boolean }[] = [];
    const finalizeOnly: Live[] = [];
    for (const x of ready) {
      const { m, key } = x;
      const rec = this.store.get(key);
      const period = m.terms.periodSecs as number;
      const start = m.startTs.toNumber();
      if (now < start) continue; // setup window: checks record nothing yet
      if (periodsBehind(m, now) > 0) {
        finalizeOnly.push(x);
        continue;
      }
      const o = this.observe(x, rec, now);
      const rules = assessWithRules(o);
      const prevRisk = this.riskOf.get(key) ?? 0;
      this.riskOf.set(key, rules.risk);
      if (!this.next.has(key)) this.next.set(key, now + checkGap(period, rules.risk, samples, weighted) / 2);
      else if (weighted && prevRisk < 0.6 && rules.risk >= 0.6) this.next.set(key, Math.min(this.next.get(key)!, now + checkGap(period, rules.risk, samples, true) / 2));
      const periodEnd = start + (m.currentPeriod + 1) * period;
      const urgent = m.curSnapshots === 0 && periodEnd - now <= coverageDeadline(period);
      if (urgent || now >= this.next.get(key)!) due.push({ x, rec, o, risk: rules.risk, urgent });
    }
    due.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (weighted ? b.risk - a.risk : (this.next.get(a.x.key) ?? 0) - (this.next.get(b.x.key) ?? 0)));

    // Spend the budget in priority order; coverage-deadline checks always go.
    const admitted: typeof due = [];
    for (const d of due) {
      if (!d.urgent && this.budgetLeft() <= 0) continue;
      this.spent.push(Date.now());
      admitted.push(d);
    }

    await Promise.all([
      eachLimit(finalizeOnly, 2, async (x) => {
        await sendIxs(this.conn, this.me, [await this.client.finalize({ mandate: x.pubkey, m: x.m })], [], { idempotent: true, deadlineMs: 30_000 });
        await this.emit(x.key, "closed out elapsed periods");
      }),
      // Checks: several at a time, at most one per SLA per tick.
      eachLimit(admitted, this.opts.checkConcurrency ?? 4, async (d) => {
        const { x } = d;
        const period = x.m.terms.periodSecs as number;
        let published: Assessment | undefined;
        try {
          const r = await this.readFor(x, d.rec, d.o, now);
          const ixs = [await this.client.snapshot({ cranker: this.me.publicKey, mandate: x.pubkey, m: x.m })];
          if (r) {
            published = r.a;
            ixs.push(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: this.me.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(encodeSentinelMemo(r.read)) }));
          }
          await sendIxs(this.conn, this.me, ixs, [], { idempotent: true, deadlineMs: 45_000 });
          const after: Live = { ...x, m: await fetchMandate(this.conn, this.client, x.pubkey) };
          this.syncChecks(d.rec, after.m);
          const t = Math.floor(Date.now() / 1000);
          await this.queueModel(after, d.rec, this.observe(after, d.rec, t), t);
          await this.emit(x.key, "checked", { assessment: published, ok: !!after.m.last.ok, m: after.m });
        } catch (e: any) {
          await this.emit(x.key, `error: ${e.message?.split("\n")[0] ?? e}`);
        }
        this.next.set(x.key, now + checkGap(period, published?.risk ?? d.risk, samples, weighted));
      }),
      // Unwind and settle what has ended.
      eachLimit(
        all.filter((x) => ["Breached", "Expired"].includes(statusName(x.m.status))),
        2,
        async ({ pubkey, m }) => {
          try {
            const did = await closeOut(this.conn, this.me, this.client, pubkey, m);
            if (did) await this.emit(pubkey.toBase58(), did);
          } catch (e: any) {
            await this.emit(pubkey.toBase58(), `error: ${e.message?.split("\n")[0] ?? e}`);
          }
        },
      ),
    ]);

    this.store.flush();
  }
}
