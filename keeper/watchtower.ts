/**
 * A watchtower with a sentinel. Each tick it reads the live SLAs, remembers what its checks
 * found and what each maker did (from the program's own events), and triages every SLA:
 *
 *   - Rules (instant, free, and the better predictor in docs/sentinel-eval.json) estimate
 *     whether the next check will fail. That sets how soon the SLA is checked again: still at
 *     random, so makers can't predict it, but more often where failure is likely, with a
 *     floor for everyone and an optional budget of checks per minute.
 *   - When it checks, a System One model (Jev) judges the breach outlook and whether the maker
 *     is leaving on purpose, and settles the diagnosis where the rules are unsure. The result
 *     rides along as an SPL Memo on the check transaction, public and timestamped.
 *
 * Enforcement is untouched: the program measures, pays and slashes on its own; the memo is
 * advisory. The watchtower also closes out periods, unwinds and settles, like the cranker.
 */
import { EventParser } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { AccountLayout, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MANDATE_PROGRAM_ID, MEMO_PROGRAM_ID, MandateClient, decodeLbPair, pda, statusName } from "../sdk/src";
import { encodeSentinelMemo } from "../sdk/src/sentinel";
import type { SystemOneConfig } from "../sdk/src/systemone";
import { chainTime, fetchMandate, fetchMandates, sendIxs } from "./common";
import { assessWithModel, assessWithRules, type Assessment, type Measurement, type Observation } from "./sentinel";

export interface WatchOptions {
  /** Baseline random checks per period for an SLA with no signs of trouble. */
  samplesPerPeriod?: number;
  /** Check more often where the next check is likely to fail. */
  riskWeighted?: boolean;
  /** Decision model for the breach outlook, intent and uncertain diagnoses; null for rules only. */
  sentinel?: SystemOneConfig | null;
  /** Cap on checks per minute across every SLA (a watchtower's fee and RPC budget). */
  budgetPerMinute?: number;
  /** Minimum seconds between model calls for one SLA, unless its situation changes. */
  modelEverySecs?: number;
  quoteSymbol?: string;
  /** Token symbol for a base mint, for the state the model reads. */
  symbolOf?: (mint: PublicKey) => string | undefined;
  onEvent?: (mandate: string, what: string, detail?: { assessment?: Assessment; ok?: boolean; m?: any }) => void | Promise<void>;
}

interface Watch {
  next?: number;
  checks: (Omit<Measurement, "agoSecs"> & { ts: number })[];
  events: { newest?: string; seen: Set<string>; activity: { ts: number; action: string }[]; readAt: number };
  model?: { at: number; a: Assessment; diagnosis: string };
  rules?: Assessment;
}

const RULES_CONFIDENT = 0.75;

/**
 * Seconds until an SLA's next check: uniform on [0, 2 × mean], so checks stay unpredictable,
 * with the mean shrinking from period/samples toward a fifth of it as the failure risk grows.
 */
export function checkGap(periodSecs: number, risk: number, samplesPerPeriod = 3, riskWeighted = true, rand = Math.random) {
  const mean = (periodSecs / samplesPerPeriod) * (riskWeighted ? 1 - 0.8 * Math.min(1, Math.max(0, risk)) : 1);
  return rand() * 2 * mean;
}

export class Watchtower {
  private watch = new Map<string, Watch>();
  private list = { at: 0, keys: [] as PublicKey[] };
  private binSteps = new Map<string, number>();
  private spent: number[] = [];
  private parser: EventParser;

  constructor(private conn: Connection, private me: Keypair, private client: MandateClient, private opts: WatchOptions = {}) {
    this.parser = new EventParser(MANDATE_PROGRAM_ID, client.program.coder);
  }

  /** The latest assessment per SLA (for logs and tests). */
  latest(mandate: string) {
    const w = this.watch.get(mandate);
    return w ? { rules: w.rules, model: w.model?.a } : null;
  }

  private async mandates() {
    if (Date.now() - this.list.at > 60_000) {
      const all = await fetchMandates(this.conn, this.client);
      this.list = { at: Date.now(), keys: all.map((x) => x.pubkey) };
      return all;
    }
    const infos = await this.conn.getMultipleAccountsInfo(this.list.keys);
    return this.list.keys.flatMap((pubkey, i) => (infos[i] ? [{ pubkey, m: this.client.decodeMandate(infos[i]!.data) }] : []));
  }

  /** The maker's own liquidity actions on this SLA, read incrementally from program events. */
  private async readActivity(key: PublicKey, m: any, w: Watch) {
    const sigs = await this.conn.getSignaturesForAddress(key, { limit: 25, until: w.events.newest }, "confirmed");
    const fresh = sigs.filter((s) => !s.err && !w.events.seen.has(s.signature));
    for (const s of fresh.reverse()) {
      const tx = await this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => undefined);
      if (tx === undefined) return; // retry from here next time
      w.events.seen.add(s.signature);
      if (!tx?.meta?.logMessages) continue;
      const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();
      if (signer !== (m.maker as PublicKey).toBase58()) continue;
      const ts = tx.blockTime ?? s.blockTime ?? Math.floor(Date.now() / 1000);
      for (const ev of this.parser.parseLogs(tx.meta.logMessages)) {
        const d = ev.data as any;
        const q = this.opts.quoteSymbol ?? "USDC";
        const n = (v: any) => Math.round(Number(v) / 1e6).toLocaleString("en-US");
        if (ev.name === "liquidityDeployed") {
          const parts = [Number(d.amountQuote) > 0 ? `${n(d.amountQuote)} ${q} of bids` : "", Number(d.amountBase) > 0 ? `${n(d.amountBase)} tokens of asks` : ""].filter(Boolean);
          w.events.activity.unshift({ ts, action: `placed ${parts.join(" and ")} near the reference price` });
        } else if (ev.name === "liquidityWithdrawn") {
          const bps = Number(d.bps);
          w.events.activity.unshift({ ts, action: bps >= 10_000 ? "withdrew all of its liquidity back to escrow" : `withdrew ${bps / 100}% of its liquidity back to escrow` });
        } else if (ev.name === "makerFeesClaimed") {
          w.events.activity.unshift({ ts, action: `collected ${n(d.amount)} ${q} of earned fees` });
        }
      }
      w.events.activity.length = Math.min(w.events.activity.length, 8);
    }
    if (sigs.length) w.events.newest = sigs[0].signature;
    w.events.readAt = Date.now();
  }

  private observe(m: any, w: Watch, now: number, extra: { binStep: number; baseIdle: bigint; quoteIdle: bigint; profile: any | null }): Observation {
    const t = m.terms;
    const q = (v: any) => Number(v) / 1e6;
    if (!w.checks.length && m.last.ts.toNumber() > 0) {
      const l = m.last;
      w.checks.push({ ts: l.ts.toNumber(), ok: !!l.ok, bids: q(l.bidDepthQuote), asks: q(l.askDepthQuote), spreadBps: l.spreadBps === 65535 ? null : l.spreadBps });
    }
    const open = !(m.position as PublicKey).equals(PublicKey.default);
    const pct = (b: number) => (Math.pow(1 + extra.binStep / 10_000, b - m.anchor.bin) - 1) * 100;
    const lower = m.positionLowerBinId as number;
    const upper = lower + (m.positionWidth as number) - 1;
    const p = extra.profile;
    return {
      pair: `${this.opts.symbolOf?.(m.baseMint) ?? "the token"}/${this.opts.quoteSymbol ?? "USDC"}`,
      quote: this.opts.quoteSymbol ?? "USDC",
      terms: { minDepth: q(t.minDepthQuote), windowPct: t.depthWindowBps / 100, maxSpreadBps: t.maxSpreadBps, periodSecs: t.periodSecs, maxFailures: t.maxConsecutiveFailures },
      acceptedAgoSecs: now - m.startTs.toNumber(),
      checks: w.checks.map((c) => ({ ...c, agoSecs: Math.max(0, now - c.ts) })),
      failedPeriodsInARow: m.consecutiveFailed,
      makerActivity: w.events.activity.map((a) => ({ agoSecs: Math.max(0, now - a.ts), action: a.action })),
      position: open ? { open, lowerPct: pct(lower), upperPct: pct(upper + 1) } : { open: false },
      // Only certain facts: with no position open, everything is back in escrow. How much of an
      // open position's inventory is deployed isn't known without reading every bin.
      escrowIdleShare: !open ? 1 : null,
      record: p ? { periodsMet: Number(p.periodsOk), periodsScored: Number(p.periodsOk) + Number(p.periodsFailed), breaches: p.mandatesBreached, agreements: p.mandatesAccepted } : null,
    };
  }

  private gap(periodSecs: number, risk: number) {
    return checkGap(periodSecs, risk, this.opts.samplesPerPeriod ?? 3, this.opts.riskWeighted !== false);
  }

  private budgetLeft() {
    const cap = this.opts.budgetPerMinute;
    if (!cap) return Infinity;
    const cutoff = Date.now() - 60_000;
    this.spent = this.spent.filter((t) => t > cutoff);
    return cap - this.spent.length;
  }

  /** Rules for the risk and the confident diagnoses; the model for the outlook, intent and the rest. */
  private async judge(w: Watch, o: Observation, now: number): Promise<Assessment> {
    const rules = assessWithRules(o);
    const cfg = this.opts.sentinel;
    // No recorded check means no evidence for a model to weigh: say so rather than guess.
    if (!cfg || !o.checks.length) return rules;
    const changed = w.model?.diagnosis !== rules.diagnosis;
    const stale = !w.model || now - w.model.at >= (this.opts.modelEverySecs ?? 45);
    if (changed || stale || rules.confidence < RULES_CONFIDENT) {
      try {
        const a = await assessWithModel(cfg, o);
        w.model = { at: now, a, diagnosis: rules.diagnosis };
      } catch {
        /* keep the last model answer, or the rules alone */
      }
    }
    const model = w.model?.a;
    if (!model) return rules;
    return {
      risk: rules.risk,
      breach: model.breach,
      exit: model.exit,
      diagnosis: rules.confidence >= RULES_CONFIDENT ? rules.diagnosis : model.diagnosis,
      confidence: rules.confidence >= RULES_CONFIDENT ? rules.confidence : model.confidence,
      source: `${model.source}+rules`,
      latencyMs: model.latencyMs,
    };
  }

  async tick() {
    const now = await chainTime(this.conn);
    const all = await this.mandates();
    const live = all.filter((x) => statusName(x.m.status) === "Active");

    // One batched read for every live SLA's vaults and maker profile; pairs once for their bin step.
    const extraKeys = live.flatMap(({ m }) => [m.baseVault, m.quoteVault, pda.makerProfile(m.maker)]);
    const extraInfos = extraKeys.length ? await this.conn.getMultipleAccountsInfo(extraKeys) : [];
    const missingPairs = [...new Set(live.map(({ m }) => m.lbPair.toBase58()))].filter((k) => !this.binSteps.has(k));
    if (missingPairs.length) {
      const infos = await this.conn.getMultipleAccountsInfo(missingPairs.map((k) => new PublicKey(k)));
      infos.forEach((info, i) => info && this.binSteps.set(missingPairs[i], decodeLbPair(info.data).binStep));
    }

    // Triage every live SLA with the rules; collect the ones due for a check.
    const due: { key: PublicKey; m: any; w: Watch; o: Observation; risk: number }[] = [];
    for (const [i, { pubkey, m }] of live.entries()) {
      const key = pubkey.toBase58();
      const w = this.watch.get(key) ?? { checks: [], events: { seen: new Set<string>(), activity: [], readAt: 0 } };
      this.watch.set(key, w);
      if (Date.now() - w.events.readAt > 15_000) await this.readActivity(pubkey, m, w).catch(() => undefined);
      const [bv, qv, prof] = extraInfos.slice(i * 3, i * 3 + 3);
      const o = this.observe(m, w, now, {
        binStep: this.binSteps.get(m.lbPair.toBase58()) ?? 10,
        baseIdle: bv ? AccountLayout.decode(bv.data).amount : 0n,
        quoteIdle: qv ? AccountLayout.decode(qv.data).amount : 0n,
        profile: prof ? this.client.decodeMakerProfile(prof.data) : null,
      });
      const rules = assessWithRules(o);
      const jumped = (w.rules?.risk ?? 0) < 0.6 && rules.risk >= 0.6;
      w.rules = rules;
      const period = m.terms.periodSecs as number;
      if (w.next === undefined) w.next = now + this.gap(period, rules.risk) / 2;
      else if (jumped && this.opts.riskWeighted !== false) w.next = Math.min(w.next, now + this.gap(period, rules.risk) / 2);
      if (now >= w.next) due.push({ key: pubkey, m, w, o, risk: rules.risk });
      else if (Math.floor((now - m.startTs.toNumber()) / period) > m.currentPeriod) {
        const ok = await sendIxs(this.conn, this.me, [await this.client.finalize({ mandate: pubkey, m })]).then(() => true, () => false);
        if (ok) await this.opts.onEvent?.(key, "closed out elapsed periods");
      }
    }

    // Spend the budget on the riskiest due SLAs first (or in order of due time when not risk-weighted).
    due.sort((a, b) => (this.opts.riskWeighted === false ? (a.w.next ?? 0) - (b.w.next ?? 0) : b.risk - a.risk));
    for (const d of due) {
      if (this.budgetLeft() <= 0) break;
      const key = d.key.toBase58();
      const a = await this.judge(d.w, d.o, now);
      const memo = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(encodeSentinelMemo(a)) });
      try {
        await sendIxs(this.conn, this.me, [await this.client.snapshot({ cranker: this.me.publicKey, mandate: d.key, m: d.m }), memo]);
        this.spent.push(Date.now());
        const m = await fetchMandate(this.conn, this.client, d.key);
        const l = m.last;
        if (l.ts.toNumber() > (d.w.checks[0]?.ts ?? 0)) {
          d.w.checks.unshift({ ts: l.ts.toNumber(), ok: !!l.ok, bids: Number(l.bidDepthQuote) / 1e6, asks: Number(l.askDepthQuote) / 1e6, spreadBps: l.spreadBps === 65535 ? null : l.spreadBps });
          d.w.checks.length = Math.min(d.w.checks.length, 8);
        }
        await this.opts.onEvent?.(key, "checked", { assessment: a, ok: !!l.ok, m });
      } catch (e: any) {
        await this.opts.onEvent?.(key, `error: ${e.message?.split("\n")[0] ?? e}`);
      }
      d.w.next = now + this.gap(d.m.terms.periodSecs, a.risk);
    }

    // Unwind and settle what has ended.
    for (const { pubkey, m } of all) {
      const status = statusName(m.status);
      if (status !== "Breached" && status !== "Expired") continue;
      const key = pubkey.toBase58();
      try {
        if (!(m.position as PublicKey).equals(PublicKey.default)) {
          const info = await this.conn.getAccountInfo(m.lbPair);
          const pair = decodeLbPair(info!.data);
          await sendIxs(this.conn, this.me, [
            await this.client.removeLiquidity({ authority: this.me.publicKey, mandate: pubkey, m, pair }),
            await this.client.closePosition({ authority: this.me.publicKey, mandate: pubkey, m }),
          ]);
          await this.opts.onEvent?.(key, `unwound the ${status.toLowerCase()} mandate`);
        } else {
          const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
          await sendIxs(this.conn, this.me, [
            createAssociatedTokenAccountIdempotentInstruction(this.me.publicKey, ata(m.baseMint, m.issuer), m.issuer, m.baseMint),
            createAssociatedTokenAccountIdempotentInstruction(this.me.publicKey, ata(m.quoteMint, m.issuer), m.issuer, m.quoteMint),
            createAssociatedTokenAccountIdempotentInstruction(this.me.publicKey, ata(m.quoteMint, m.maker), m.maker, m.quoteMint),
            await this.client.settle({ mandate: pubkey, m }),
          ]);
          await this.opts.onEvent?.(key, `settled the ${status.toLowerCase()} mandate`);
        }
      } catch (e: any) {
        await this.opts.onEvent?.(key, `error: ${e.message?.split("\n")[0] ?? e}`);
      }
    }
  }
}
