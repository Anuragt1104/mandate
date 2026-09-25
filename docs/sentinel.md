# The sentinel: System One models in the watchtower

Mandate's enforcement is deterministic: the program measures committed liquidity, pays for
compliant periods and slashes after failed ones. None of that uses a model, and none of it
should: nobody can audit why a probabilistic judgment slashed a bond.

What the program can't do is decide *where to look*. Checks cost fees and RPC calls, a period
nobody checks is neither paid nor failed, and a breach needs three **checked** failing periods
in a row. On devnet, when public RPC slowed our watchtower to one check per agreement every
~90 seconds against one-minute periods, failing agreements went unobserved and breaches took
far longer to confirm. That is a triage problem, and it is where System One models fit:
fast, typed decisions with calibrated probabilities, no generated text to parse.

## What was built

`keeper/watchtower.ts` checks live SLAs at random times, like the plain cranker, plus:

1. **Code gathers the facts.** For each SLA it keeps what its own checks found and what the
   maker did (from the program's events: placed, withdrew, collected fees), and states every
   comparison in words, because decision models are weak at arithmetic and time
   (`keeper/sentinel.ts`, `describe`).
2. **Rules set the check schedule.** Hand-written rules estimate whether the next check will
   fail. That probability shrinks the mean gap between random checks by up to 5x, spends a
   scarce budget on the riskiest SLAs first, and pulls the next check forward when a maker's
   withdrawal shows up in its events. Every SLA keeps a floor of random checks.
3. **Jev judges what the rules can't.** When the watchtower checks an SLA, Jev 1.13 answers
   three typed questions about the same facts in one call (about 340 ms): will this maker let
   the agreement breach (Noul), is it leaving on purpose (Noul), and, where the rules are
   unsure, what is going on (Choice of seven situations).
4. **The read is published.** The assessment rides on the check transaction as an SPL Memo,
   e.g. `mandate-sentinel/1 r=0.90 b=0.77 d=withdrew_liquidity c=0.85 x=0.76 m=jev-1.13.0+rules`.
   The program ignores it; the app shows it on each SLA's status page ("Watchtower outlook"),
   on incidents ("Watchtower read: Maker withdrew liquidity") and in the activity feed.

If no model is configured or it fails, the rules answer alone and nothing else changes.

## Where models were considered and not used

- **Scoring, payouts, slashing.** Must stay deterministic and verifiable.
- **The next-check risk.** The evaluation below shows the rules predict it slightly better,
  instantly and for free, so the schedule runs on rules.
- **Drafting terms from a plain-language brief.** The numbers (depth, spread) are better
  derived from on-chain pool data than from prose.
- **Quoting decisions for makers, token screening.** Deterministic strategies quote better,
  and screening tokens is outside Mandate's job.

## Model choice

The code speaks TypeSafe's System One API (`sdk/src/systemone.ts`), so it runs against Jev
directly (`TYPESAFE_API_KEY`), Jev on Venice (`VENICE_API_KEY`), or an open model with the
same API such as Kev or CLM (`SYSTEMONE_URL`). On the independent Decision Index 0.2
(chance-corrected, 0 = guessing, 100 = perfect) Jev scores 51.7, Kev-4B 31.3, Kev-0.8B 13.3,
GLiNER2.5-Decide 10.0, CLM-8B 6.5 and Laya 5.5, so Jev is the default.

## Results

**Judgment quality** (`scripts/sentinel-eval.ts`, 120 scenarios across 10 kinds with a hidden
maker behaviour and a known future; `docs/sentinel-eval.json`). AUC measures ranking, 1.0 is
perfect:

| | Rules | Jev 1.13 | Deployed |
|---|---|---|---|
| Diagnosis accuracy | 0.875 | 0.975 | **0.950** |
| Next check fails (AUC) | **0.920** | 0.902 | **0.920** |
| Maker lets it breach (AUC) | 0.932 | **0.992** | **0.992** |
| Maker leaving on purpose (AUC) | 0.969 | **1.000** | **1.000** |

Jev separates a whale draining a diligent maker's asks (breach outlook ~15%) from the same
drained book under a neglectful maker (~49%) and a walk-away (~53-61%); the rules can't use
the maker's record that way. Jev's p50 latency was 344 ms.

**Enforcement speed** (`scripts/watch-bench.ts`, 400 Monte Carlo trials each, one maker walking
away among the SLAs, the watchtower's real scheduling rule):

| Setup | Uniform checks | Risk-weighted |
|---|---|---|
| 12 SLAs, 8 checks/min | breach confirmed in 275 s (p90 349), 1.6 unobserved failing periods | **206 s** (p90 231), 0 unobserved |
| 12 SLAs, 4 checks/min | 501 s, 5.6 unobserved | **206 s**, 0 unobserved |
| 30 SLAs, 12 checks/min | 432 s, 4.4 unobserved | **208 s**, 0 unobserved |

206 s is close to the floor: three one-minute periods plus the time to notice.

**Live run** (localnet, Jev over the API, a budget of 6 checks a minute): healthy SLAs read
"quoting normally", breach outlook 4-8%. Lazy Capital withdrew at 04:37:40; the first check,
12 s later, read "withdrew liquidity" with a 90% next-check risk; the breach outlook rose from
46% to 77% as failed periods accrued, the failing SLA was checked every 10-15 s while the
healthy one relaxed to 40-60 s, and the breach was confirmed at 04:40:20, 160 s after the
walk-away.

## Limits

- The scenarios are generated, so the labels are ours by construction and the rules were
  written with the same structure in mind. Real incidents are the test that matters.
- Jev reads numbers and times as text. The state therefore carries comparisons in words
  ("below the 500 USDC minimum", "after the latest check"); two early mistakes in the live run
  came from facts stated badly, not from the model, and were fixed in `describe`.
- With no recorded check there is nothing to judge, so the model is not asked.

## Running it

```bash
npx tsx scripts/sentinel-eval.ts 12
```

```bash
npx tsx scripts/watch-bench.ts 400 12 8
```

The simulator's watchtower uses the sentinel whenever a key is set in the repo's gitignored
`.env` (`TYPESAFE_API_KEY=...`); `SENTINEL=off` runs rules only, `RISK_WEIGHTED=off` restores
uniform checks, and `WATCH_BUDGET=6` caps checks per minute.
