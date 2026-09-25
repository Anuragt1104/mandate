/**
 * Does a System One model triage SLAs better than hand-written rules?
 *
 * Generates market-maker scenarios with a hidden behaviour and a known future, renders only
 * what a watchtower could observe, and scores the sentinel's answers from the configured
 * decision model (Jev by default) against the deterministic rules on the same observations:
 *   - failing:   will the next check fail?          (drives where checks go)
 *   - breach:    will the maker let it breach?       (the status page outlook)
 *   - diagnosis: what is going on?                   (the incident label)
 *   - exit:      is the maker leaving on purpose?
 *
 *   npx tsx scripts/sentinel-eval.ts [cases per kind, default 12] [seed]
 *
 * Writes docs/sentinel-eval.json. Needs TYPESAFE_API_KEY (or another System One endpoint,
 * see sdk/src/systemone.ts) in the environment or the repo's .env.
 */
import fs from "fs";
import path from "path";
import "../keeper/common"; // loads .env
import { systemOneFromEnv } from "../sdk/src/systemone";
import { assessWithModel, assessWithRules, type Assessment, type Diagnosis, type Measurement, type Observation } from "../keeper/sentinel";

const PER_KIND = Number(process.argv[2] ?? 12);
let seed = Number(process.argv[3] ?? 7);
const rand = () => {
  // mulberry32: reproducible scenarios
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const U = (a: number, b: number) => a + rand() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const TERMS = { minDepth: 500, windowPct: 2, maxSpreadBps: 100, periodSecs: 60, maxFailures: 3 };
const MIN = TERMS.minDepth;

interface Truth { diagnosis: Diagnosis; failing: boolean; breach: boolean; exit: boolean }
interface Case { id: string; kind: string; obs: Observation; truth: Truth }

// ---------------------------------------------------------------- building blocks

const healthy = () => MIN * U(2.5, 20);
const thin = () => MIN * U(1.05, 1.28);
const spread = () => Math.round(U(8, 70));
const check = (agoSecs: number, bids: number, asks: number): Measurement => {
  const ok = bids >= MIN && asks >= MIN;
  const empty = bids <= 0 || asks <= 0;
  return { agoSecs, ok: ok && !empty, bids, asks, spreadBps: empty ? null : ok ? spread() : Math.round(U(40, 180)) };
};
/** Passing checks going back in time from `from` seconds ago. */
function history(n: number, from: number, bids = healthy, asks = healthy): Measurement[] {
  const out: Measurement[] = [];
  let at = from;
  for (let i = 0; i < n; i++) {
    at += U(15, 40);
    out.push(check(at, bids(), asks()));
  }
  return out;
}
const record = (kind: "diligent" | "mixed" | "poor") => {
  const scored = Math.round(U(80, 3000));
  const rate = kind === "diligent" ? U(0.97, 1) : kind === "mixed" ? U(0.86, 0.95) : U(0.5, 0.8);
  const agreements = Math.round(U(1, 6));
  const breaches = kind === "diligent" ? 0 : kind === "mixed" ? Math.round(U(0, 1)) : Math.min(agreements, Math.round(U(1, 3)));
  return { periodsMet: Math.round(scored * rate), periodsScored: scored, breaches, agreements: Math.max(agreements, breaches) };
};
const place = (agoSecs: number) => ({ agoSecs, action: pick(["placed bids and asks around the reference price", "deployed inventory as bids below and asks above the reference", "added liquidity on both sides of the reference"]) });
const withdrawAll = (agoSecs: number) => ({ agoSecs, action: pick(["withdrew all liquidity back to escrow and closed its position", "pulled every bin of its liquidity back into escrow", "removed 100% of its liquidity and closed the position"]) });
const fees = (agoSecs: number) => ({ agoSecs, action: `collected ${Math.round(U(3, 60))} USDC of earned fees` });
const around = () => ({ open: true, lowerPct: -U(3.2, 3.6), upperPct: U(3.2, 3.6) });
const base = (o: Partial<Observation>): Observation => ({
  pair: pick(["ORBT/USDC", "KITE/USDC", "MAND/USDC", "NOVA/USDC"]),
  quote: "USDC",
  terms: TERMS,
  acceptedAgoSecs: U(600, 20_000),
  checks: [],
  failedPeriodsInARow: 0,
  makerActivity: [],
  position: around(),
  // As in production: the escrow fact is only stated when no position is open.
  escrowIdleShare: null,
  record: record(pick(["diligent", "diligent", "mixed"])),
  ...o,
});

// ---------------------------------------------------------------- scenario kinds

const KINDS: Record<string, () => { obs: Observation; truth: Truth }> = {
  // A maker doing its job.
  healthy: () => {
    const last = U(5, 50);
    return {
      obs: base({ checks: [check(last, healthy(), healthy()), ...history(Math.round(U(2, 5)), last)], makerActivity: [place(U(300, 3000)), ...(rand() < 0.4 ? [fees(U(3000, 9000))] : [])] }),
      truth: { diagnosis: "quoting_normally", failing: false, breach: false, exit: false },
    };
  },
  // Withdraws only to re-place around a moved price: benign.
  recentre: () => {
    const placedAgo = U(8, 40);
    const withdrewAgo = placedAgo + U(15, 45);
    const lastAgo = rand() < 0.5 ? U(2, placedAgo - 1) : withdrewAgo + U(10, 40);
    return {
      obs: base({ checks: [check(lastAgo, healthy(), healthy()), ...history(3, lastAgo)], makerActivity: [place(placedAgo), withdrawAll(withdrewAgo), place(U(1200, 6000))] }),
      truth: { diagnosis: "quoting_normally", failing: false, breach: false, exit: false },
    };
  },
  // The early warning: the last check passed, then the maker pulled everything.
  exit_after_check: () => {
    const withdrewAgo = U(8, 45);
    const lastAgo = withdrewAgo + U(20, 90);
    const act = [withdrawAll(withdrewAgo), ...(rand() < 0.5 ? [fees(withdrewAgo + U(20, 200))] : []), place(U(1500, 9000))];
    return {
      obs: base({ checks: [check(lastAgo, healthy(), healthy()), ...history(3, lastAgo)], makerActivity: act, position: { open: false }, escrowIdleShare: 1, record: record(pick(["diligent", "mixed", "poor"])) }),
      truth: { diagnosis: "withdrew_liquidity", failing: true, breach: true, exit: true },
    };
  },
  // Pulled out and the checks are already failing.
  exit_failing: () => {
    const lastAgo = U(5, 40);
    const withdrewAgo = lastAgo + U(20, 200);
    const streak = Math.round(U(0, 2));
    const earlierFails = Array.from({ length: streak }, (_, i) => check(lastAgo + 60 * (i + 1) - U(0, 20), 0, 0));
    return {
      obs: base({ checks: [check(lastAgo, 0, 0), ...earlierFails, ...history(2, withdrewAgo)], failedPeriodsInARow: streak, makerActivity: [withdrawAll(withdrewAgo), place(U(2000, 9000))], position: { open: false }, escrowIdleShare: 1, record: record(pick(["mixed", "poor", "diligent"])) }),
      truth: { diagnosis: "withdrew_liquidity", failing: true, breach: true, exit: true },
    };
  },
  // Trims inventory but stays compliant.
  partial_withdraw: () => {
    const last = U(5, 50);
    const thinSide = rand() < 0.5;
    return {
      obs: base({
        checks: [check(last, thinSide ? thin() : healthy(), thinSide ? healthy() : thin()), ...history(3, last)],
        makerActivity: [{ agoSecs: U(60, 400), action: pick(["withdrew half of its liquidity back to escrow", "removed 50% of its liquidity from the book"]) }, place(U(1500, 8000))],
      }),
      truth: { diagnosis: "thin_but_compliant", failing: false, breach: false, exit: false },
    };
  },
  // Close to the minimum after ordinary trading.
  thin: () => {
    const last = U(5, 50);
    const thinSide = rand() < 0.5;
    return {
      obs: base({ checks: [check(last, thinSide ? thin() : healthy(), thinSide ? healthy() : thin()), ...history(3, last)], makerActivity: [place(U(600, 5000))] }),
      truth: { diagnosis: "thin_but_compliant", failing: false, breach: false, exit: false },
    };
  },
  // A large trade drained one side of a diligent maker's book; it will refill.
  depleted_diligent: () => {
    const last = U(5, 35);
    const prevAgo = last + U(15, 40);
    const asksSide = rand() < 0.5;
    const before = check(prevAgo, U(3000, 6000), U(3000, 6000));
    const now = asksSide ? check(last, before.bids + U(2500, 5000), U(0, 420)) : check(last, U(0, 420), before.asks + U(2500, 5000));
    return {
      obs: base({ checks: [now, before, ...history(3, prevAgo)], makerActivity: [place(U(400, 2400)), ...(rand() < 0.5 ? [place(U(3000, 9000))] : [])], record: record("diligent") }),
      truth: { diagnosis: "side_depleted_by_trading", failing: true, breach: false, exit: false },
    };
  },
  // The same drained side, under a maker that has stopped tending its book.
  depleted_neglected: () => {
    const last = U(5, 35);
    const prevAgo = last + U(15, 40);
    const asksSide = rand() < 0.5;
    const before = check(prevAgo, asksSide ? U(6000, 9000) : U(0, 400), asksSide ? U(0, 400) : U(6000, 9000));
    const now = check(last, asksSide ? before.bids * U(0.97, 1.03) : U(0, 300), asksSide ? U(0, 300) : before.asks * U(0.97, 1.03));
    const streak = Math.round(U(1, 2));
    return {
      obs: base({ checks: [now, before, ...history(1, prevAgo)], failedPeriodsInARow: streak, makerActivity: [place(U(9000, 30000))], record: record("poor") }),
      truth: { diagnosis: "side_depleted_by_trading", failing: true, breach: true, exit: false },
    };
  },
  // The price walked out of a sleeping maker's range.
  out_of_range: () => {
    const last = U(5, 40);
    const above = rand() < 0.5;
    const lower = above ? -U(9, 12) : U(2.4, 3.2);
    const upper = above ? -U(2.4, 3.2) : U(9, 12);
    return {
      obs: base({
        checks: [check(last, above ? U(0, 250) : 0, above ? 0 : U(0, 250)), ...history(2, last + U(60, 200))],
        failedPeriodsInARow: Math.round(U(0, 2)),
        makerActivity: [place(U(2400, 12000))],
        position: { open: true, lowerPct: lower, upperPct: upper },
        record: record(pick(["mixed", "poor"])),
      }),
      truth: { diagnosis: "out_of_range", failing: true, breach: true, exit: false },
    };
  },
  // Just accepted; liquidity not placed yet.
  not_started: () => ({
    obs: base({ acceptedAgoSecs: U(8, 45), checks: [], makerActivity: [], position: { open: false }, escrowIdleShare: 1, record: record(pick(["diligent", "mixed"])) }),
    truth: { diagnosis: "not_started", failing: false, breach: false, exit: false },
  }),
};

// ---------------------------------------------------------------- metrics

const brier = (p: number[], y: boolean[]) => p.reduce((s, x, i) => s + (x - (y[i] ? 1 : 0)) ** 2, 0) / p.length;
function auc(p: number[], y: boolean[]) {
  const pos = p.filter((_, i) => y[i]);
  const neg = p.filter((_, i) => !y[i]);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
const acc = (p: number[], y: boolean[]) => p.filter((x, i) => x >= 0.5 === y[i]).length / p.length;
const pctl = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function score(name: string, cases: Case[], as: (Assessment | null)[]) {
  const ok = cases.map((_, i) => as[i]).filter(Boolean) as Assessment[];
  const cs = cases.filter((_, i) => as[i]);
  const col = (f: (a: Assessment) => number) => ok.map(f);
  const y = (f: (t: Truth) => boolean) => cs.map((c) => f(c.truth));
  const byKind: Record<string, { n: number; diagnosis: number; failing: number; breach: number; exit: number }> = {};
  cs.forEach((c, i) => {
    const k = (byKind[c.kind] ??= { n: 0, diagnosis: 0, failing: 0, breach: 0, exit: 0 });
    k.n++;
    k.diagnosis += Number(ok[i].diagnosis === c.truth.diagnosis);
    k.failing += ok[i].risk;
    k.breach += ok[i].breach;
    k.exit += ok[i].exit;
  });
  for (const k of Object.values(byKind)) {
    k.diagnosis /= k.n;
    k.failing /= k.n;
    k.breach /= k.n;
    k.exit /= k.n;
  }
  return {
    name,
    answered: ok.length,
    diagnosisAccuracy: ok.filter((a, i) => a.diagnosis === cs[i].truth.diagnosis).length / ok.length,
    failing: { brier: brier(col((a) => a.risk), y((t) => t.failing)), auc: auc(col((a) => a.risk), y((t) => t.failing)), accuracy: acc(col((a) => a.risk), y((t) => t.failing)) },
    breach: { brier: brier(col((a) => a.breach), y((t) => t.breach)), auc: auc(col((a) => a.breach), y((t) => t.breach)), accuracy: acc(col((a) => a.breach), y((t) => t.breach)) },
    exit: { brier: brier(col((a) => a.exit), y((t) => t.exit)), auc: auc(col((a) => a.exit), y((t) => t.exit)), accuracy: acc(col((a) => a.exit), y((t) => t.exit)) },
    latencyMs: ok.some((a) => a.latencyMs) ? { p50: pctl(col((a) => a.latencyMs), 0.5), p95: pctl(col((a) => a.latencyMs), 0.95) } : null,
    byKind,
  };
}

async function main() {
  const cfg = systemOneFromEnv(process.env);
  if (!cfg) throw new Error("No System One endpoint configured: set TYPESAFE_API_KEY (or SYSTEMONE_URL / VENICE_API_KEY) in .env");
  const cases: Case[] = [];
  for (const [kind, make] of Object.entries(KINDS)) for (let i = 0; i < PER_KIND; i++) cases.push({ id: `${kind}-${i}`, kind, ...make() });
  console.log(`${cases.length} scenarios across ${Object.keys(KINDS).length} kinds; model endpoint ${new URL(cfg.url).host}`);

  const rules = cases.map((c) => assessWithRules(c.obs));
  let failures = 0;
  const model = await mapLimit(cases, 4, async (c) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await assessWithModel(cfg, c.obs);
      } catch (e: any) {
        if (attempt === 2) {
          failures++;
          console.log(`  ${c.id}: ${e.message?.slice(0, 120)}`);
          return null;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return null;
  });

  // The hybrid: rules where they are confident, the model's answer (already fetched) otherwise.
  const GATE = 0.75;
  const hybrid = cases.map((_, i) => (rules[i].confidence >= GATE || !model[i] ? rules[i] : model[i]));
  // What the watchtower actually publishes (keeper/watchtower.ts judge): the rules' next-check
  // risk, the model's breach outlook and intent, and the diagnosis from whichever is confident.
  const deployed: (Assessment | null)[] = cases.map((_, i) => {
    const r = rules[i];
    const m = model[i];
    if (!m) return r;
    return { ...r, breach: m.breach, exit: m.exit, diagnosis: r.confidence >= GATE ? r.diagnosis : m.diagnosis, confidence: r.confidence >= GATE ? r.confidence : m.confidence, source: `${m.source}+rules`, latencyMs: m.latencyMs };
  });
  const routed = rules.filter((r) => r.confidence < GATE).length;
  const modelName = model.find(Boolean)?.source ?? "model";
  const report = {
    generatedAt: new Date().toISOString(), perKind: PER_KIND, seed: Number(process.argv[3] ?? 7), model: modelName, failures,
    hybrid: { gate: GATE, routedToModel: routed, of: cases.length },
    results: [score("rules", cases, rules), score(modelName, cases, model), score("hybrid", cases, hybrid), score("deployed", cases, deployed)],
  };
  const out = path.resolve(__dirname, "../docs/sentinel-eval.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  const f = (x: number) => (isNaN(x) ? "  —  " : x.toFixed(3));
  console.log(`\n${"".padEnd(22)}${report.results.map((r) => r.name.padStart(14)).join("")}`);
  const row = (label: string, g: (r: any) => number) => console.log(`${label.padEnd(22)}${report.results.map((r) => f(g(r)).padStart(14)).join("")}`);
  row("diagnosis accuracy", (r) => r.diagnosisAccuracy);
  row("failing  AUC", (r) => r.failing.auc);
  row("failing  Brier", (r) => r.failing.brier);
  row("breach   AUC", (r) => r.breach.auc);
  row("breach   Brier", (r) => r.breach.brier);
  row("exit     AUC", (r) => r.exit.auc);
  row("exit     Brier", (r) => r.exit.brier);
  console.log(`\nper kind: diagnosis accuracy · mean P(failing) · mean P(breach) · mean P(exit)`);
  for (const kind of Object.keys(KINDS)) {
    const cells = report.results.map((r) => {
      const k = r.byKind[kind];
      return k ? `${f(k.diagnosis)} ${f(k.failing)} ${f(k.breach)} ${f(k.exit)}` : "";
    });
    console.log(`${kind.padEnd(20)}${cells.map((c) => c.padStart(25)).join("")}`);
  }
  const lat = report.results[1].latencyMs;
  console.log(`\nhybrid sent ${routed} of ${cases.length} observations to the model (rules confidence < ${GATE})`);
  if (lat) console.log(`latency p50 ${lat.p50} ms, p95 ${lat.p95} ms; ${failures} failed calls; wrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
