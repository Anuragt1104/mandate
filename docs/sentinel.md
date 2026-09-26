# The sentinel: System One models in the watchtower

Mandate's enforcement is deterministic: the program measures committed liquidity, pays for
compliant periods and slashes after failed ones. None of that uses a model, and none of it
should: nobody can audit why a probabilistic judgment slashed a bond.

What the program can't do is decide *where to look*. Checks cost fees and RPC calls, a period
nobody checks is neither paid nor failed, and a breach needs the agreed number of **checked**
failing periods with no passing period between them. Observation is part of the product's
economics, so the watchtower is built as a reliable service first; the model is advisory and
can never slow it down.

## How it runs

`keeper/watchtower.ts`:

1. **Observation is deadline-driven.** Every active SLA gets at least one check per period: if
   a period has had none and a quarter of it is left, a check is forced, ahead of the budget.
   Spare checks go where hand-written rules say the next check is likely to fail, still at
   random times. Checks, catch-up, unwinding and settlement run with bounded concurrency and
   every transaction has a deadline, so one slow SLA or RPC call doesn't hold up the rest.
   Transactions are signed once and re-sent as the same bytes; after expiry the signature's
   history is checked before anything is rebuilt (`keeper/common.ts`).
2. **Facts come from verified sources.** Committed depth per check (which trades cannot
   change), where the reference sat at each check, and the maker's liquidity events read from
   the program's own logs: paged back to a saved cursor, checked against the mandate they name,
   with transactions that aren't available yet retried rather than skipped. When the history
   has a gap, the facts say so and the model abstains on questions that need it.
3. **The model runs in its own queue.** After a check lands, its observation goes to a bounded
   worker (two calls at a time, an 8 s timeout, a circuit breaker after three failures in a
   row). Jev answers three typed questions in one call: the diagnosis (Choice), whether the
   agreement will breach (Noul), and, only while the obligations are unmet, whether the maker
   will fail to place liquidity that restores them over the next two periods (Noul). The next-
   check risk is not asked: the rules own scheduling.
4. **Reads are bound and signed.** The next check on that SLA carries the read as an SPL Memo
   signed by the watchtower, bound to the check it assessed:

   ```
   mandate-sentinel/2 k=<mandate> o=<check ts> at=<assessed> exp=<expires> d=withdrew_liquidity
     c=0.85 r=0.90 b=0.77 x=0.72 m=jev-1.13.0+rules p=s2 h=<facts hash>
   ```

   A model read is published only for the check it assessed and only until it expires (two
   periods, at least two minutes), combined with the rules' read of the same facts and under
   those facts' hash; otherwise the rules' read of the latest check is published. The app takes the publisher from the transaction's signed memo instruction, not
   from log text, and labels a read with its model only when the publisher is on the site's
   list (`NEXT_PUBLIC_TRUSTED_WATCHTOWERS`, plus the simulated watchtower on devnet). A read
   from anyone else is shown as unverified commentary. A signature proves who published a
   read, not that a model produced it.

If no model is configured, it times out, or its answer fails validation (every probability in
[0, 1], choices among the options, distributions summing to 1), the rules answer alone.

## Where models were considered and not used

- **Scoring, payouts, slashing.** Must stay deterministic and verifiable.
- **The next-check risk and the schedule.** Rules predict it as well, instantly and for free.
- **Drafting terms from a plain-language brief.** The numbers (depth, spread) are better
  derived from on-chain pool data than from prose.
- **Quoting decisions for makers, token screening.** Deterministic strategies quote better,
  and screening tokens is outside Mandate's job.

## Model choice

The code speaks TypeSafe's System One API (`sdk/src/systemone.ts`), so it runs against Jev
directly (`TYPESAFE_API_KEY`), Jev on Venice (`VENICE_API_KEY`), or an open model with the
same API such as Kev or CLM (`SYSTEMONE_URL`). The model is pinned to `jev-1.13.0`, the
version evaluated below; the provider's reported model id is recorded with every read. To try
another, set `SYSTEMONE_MODEL`, re-run the evaluation, and promote it only if it holds up. On
the independent Decision Index 0.2 (chance-corrected, 0 = guessing, 100 = perfect) Jev scores
51.7, Kev-4B 31.3, Kev-0.8B 13.3, GLiNER2.5-Decide 10.0, CLM-8B 6.5 and Laya 5.5.

## Results

**Synthetic judgment quality** (`scripts/sentinel-eval.ts 10 7`: 110 generated scenarios
across 11 kinds with a hidden maker behaviour and a known future; `docs/sentinel-eval.json`,
which also holds the reliability bins). Brier scores measure calibration (lower is better);
AUC only measures ranking. "Deployed" is what the watchtower publishes: the rules' risk and
confident diagnoses, the model's outlooks, the model only once a check exists.

| | Rules | Jev 1.13 | Deployed |
|---|---|---|---|
| Diagnosis accuracy | 0.945 | 0.955 | 0.936 |
| Next check fails: Brier (AUC) | 0.066 (0.940) | rules | 0.066 (0.940) |
| Breach: Brier (AUC) | 0.099 (0.935) | 0.128 (0.939) | **0.096 (0.993)** |
| No redeploy within two periods: Brier (AUC) | 0.208 (0.875) | **0.154 (0.994)** | **0.154 (0.994)** |

Jev on its own is worse calibrated than the rules on breach (it is confident about makers who
haven't started yet, which the watchtower never asks it about). Its clear contribution is the
redeployment outlook. p50 latency 354 ms, p95 427 ms, no failed calls.

**Enforcement speed** (`scripts/watch-bench.ts`, 400 Monte Carlo trials each, one maker walking
away among the SLAs). This measures the rules-driven schedule, not the model:

| Setup | Uniform checks | Risk-weighted |
|---|---|---|
| 12 SLAs, 8 checks/min | breach confirmed in 275 s (p90 349), 1.6 unobserved failing periods | **206 s** (p90 231), 0 unobserved |
| 12 SLAs, 4 checks/min | 501 s, 5.6 unobserved | **206 s**, 0 unobserved |
| 30 SLAs, 12 checks/min | 432 s, 4.4 unobserved | **208 s**, 0 unobserved |

## Limits

- The scenarios are generated: the labels are ours by construction and the rules were written
  with the same structure in mind. They compare policies and catch regressions; they are not
  evidence of real-world accuracy. The test that matters is a chronological holdout of real
  program events (swaps, rebalances, partial withdrawals, RPC gaps, hourly periods), frozen
  before comparing policies.
- A model reading the maker's service history inherits its weaknesses: the history counts
  periods, not stake or counterparties, and can be built with friendly issuers. The facts call
  it "service history" and say so.
- Jev reads numbers and times as text; the state states comparisons in words.
- Watchtower state lives in a JSON file (`.keeper/`), enough for one process to resume after a
  restart. Several keepers, or a pilot with money at stake, need a real database.

## Running it

```bash
npx tsx scripts/sentinel-eval.ts 10 7
```

```bash
npx tsx scripts/watch-bench.ts 400 12 8
```

The simulator's watchtower uses the sentinel whenever a key is set in the repo's gitignored
`.env` (`TYPESAFE_API_KEY=...`); `SENTINEL=off` runs rules only, `RISK_WEIGHTED=off` restores
uniform checks, and `WATCH_BUDGET=6` caps checks per minute (coverage-deadline checks still run).
