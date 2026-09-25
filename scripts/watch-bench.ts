/**
 * How much faster does a risk-weighted watchtower confirm a breach on the same check budget?
 *
 * Monte Carlo over the watchtower's real scheduling rule (keeper/watchtower.ts checkGap): a
 * set of SLAs with one-minute periods, one maker that walks away at a random time, and a
 * budget of checks per minute. Unobserved periods count for nothing, so a breach needs three
 * *checked* failing periods in a row. Uniform scheduling spreads checks evenly; risk-weighted
 * scheduling feeds the rules' next-check risk (0.9 once the withdrawal event or a failed check
 * is seen) into checkGap and spends a scarce budget on the riskiest SLAs first.
 *
 *   npx tsx scripts/watch-bench.ts [trials] [slas] [budget per minute]
 */
import { checkGap } from "../keeper/watchtower";

const TRIALS = Number(process.argv[2] ?? 400);
const SLAS = Number(process.argv[3] ?? 12);
const BUDGET = Number(process.argv[4] ?? 8);
const PERIOD = 60;
const MAX_FAIL = 3;
const EVENT_READ_EVERY = 15; // the watchtower reads maker activity every 15 s

function trial(weighted: boolean) {
  const exitAt = 60 + Math.random() * 120;
  const next = Array.from({ length: SLAS }, () => checkGap(PERIOD, 0.05, 3, weighted) / 2);
  const risk = Array.from({ length: SLAS }, () => 0.05);
  const spent: number[] = [];
  let checkedThisPeriod = false;
  let failedThisPeriod = false;
  let streak = 0;
  let checksOnHealthy = 0;
  let unobserved = 0;
  let lastEventRead = 0;
  for (let t = 0; t < 60 * 30; t++) {
    const failing = t >= exitAt;
    // Period boundary for the walking SLA (index 0), scored the way the program scores it:
    // any failed check fails the period, a checked period without one resets the streak, and
    // a period nobody checked changes nothing.
    if (t > 0 && t % PERIOD === 0) {
      if (failedThisPeriod) streak++;
      else if (checkedThisPeriod) streak = 0;
      else if (t > exitAt) unobserved++;
      if (streak >= MAX_FAIL) return { breachAfter: t - exitAt, unobserved, checksOnHealthy };
      checkedThisPeriod = failedThisPeriod = false;
    }
    // The withdrawal becomes visible the next time the watchtower reads maker activity.
    if (t - lastEventRead >= EVENT_READ_EVERY) {
      lastEventRead = t;
      if (failing && weighted && risk[0] < 0.9) {
        risk[0] = 0.9;
        next[0] = Math.min(next[0], t + checkGap(PERIOD, 0.9, 3, weighted) / 2);
      }
    }
    while (spent.length && spent[0] <= t - 60) spent.shift();
    const due = next.map((n, i) => ({ i, n })).filter((d) => d.n <= t);
    due.sort((a, b) => (weighted ? risk[b.i] - risk[a.i] : a.n - b.n));
    for (const d of due) {
      if (spent.length >= BUDGET) break;
      spent.push(t);
      if (d.i === 0) {
        checkedThisPeriod = true;
        if (failing) {
          failedThisPeriod = true;
          if (weighted) risk[0] = 0.9;
        }
      } else checksOnHealthy++;
      next[d.i] = t + checkGap(PERIOD, risk[d.i], 3, weighted);
    }
  }
  return { breachAfter: Infinity, unobserved, checksOnHealthy };
}

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
for (const weighted of [false, true]) {
  const rs = Array.from({ length: TRIALS }, () => trial(weighted));
  const b = rs.map((r) => r.breachAfter);
  const done = b.filter(isFinite).length;
  console.log(
    `${weighted ? "risk-weighted" : "uniform      "}  breach confirmed after median ${Math.round(q(b, 0.5))} s, p90 ${Math.round(q(b, 0.9))} s ` +
      `(${done}/${TRIALS} within 30 min) · unobserved failing periods ${(rs.reduce((s, r) => s + r.unobserved, 0) / TRIALS).toFixed(2)} ` +
      `· checks on healthy SLAs ${Math.round(rs.reduce((s, r) => s + r.checksOnHealthy, 0) / TRIALS)}`,
  );
}
console.log(`${SLAS} SLAs, ${BUDGET} checks per minute, ${TRIALS} trials each`);
