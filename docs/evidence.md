# Why was this operator paid?

Every scoring period of an agreement has a page that explains its outcome from the chain:
`/app/mandate/<agreement>/period/<n>`. Clicking any tick on an agreement's service levels, or
"Why…" on an incident, opens it.

```
what was agreed  →  what was measured  →  the rule  →  the outcome  →  settlement
  (terms, fixed)     (every check in        (paid only if   (fee, or failure;   (the claim or
                      the period)            checked and     breach and slash)   settlement that
                                             all passed)                          paid the fee)
```

Each step links to its transaction. If a signed draft in the viewer's browser or workspace was
posted as this agreement, step 1 says whether the chain's terms match the approved version.

## Evidence bundle and verifier

"Download evidence" saves a JSON bundle (`sdk/src/evidence.ts`, `EvidenceBundle`): the terms,
every check of the period with its measurements and signature, the period's finalization, any
slash, and the payout. `scripts/explain.ts` checks it:

```bash
# recompute offline (no network)
npx tsx scripts/explain.ts --bundle mandate-evidence-GTsckyDv-p24.json

# and re-fetch every cited transaction from an RPC you choose, comparing the logged events
npx tsx scripts/explain.ts --bundle mandate-evidence-GTsckyDv-p24.json --recheck --rpc <url>

# or collect the evidence yourself, without the site
npx tsx scripts/explain.ts --cluster devnet --mandate <agreement> --period 24 --decimals 6
```

It exits non-zero on any disagreement.

## What it proves, and what it doesn't

| | |
|---|---|
| **Recomputed** | Each check's verdict from its measurements and the terms, the period's status, the fee, the consecutive-failure count and any slash. |
| **On chain, not recomputed** | The measurements. The program computed them from the pool's accounts inside each transaction; the accounts' past state isn't served by standard RPC, so they can't be re-measured. They are exactly as trustworthy as the transactions. |
| **Trusted** | The RPC that served the transactions. `--recheck` against a second RPC tests it. |

Recomputation alone can't catch a bundle edited consistently (a measurement and its verdict
changed together): that's what `--recheck` is for, and `tests/evidence.test.ts` shows both cases.
Hashing what one RPC returned would prove nothing about whether it was truthful, so the bundle
doesn't pretend to.

Payout: every fee claim pays all fees owed at that point, so the first claim or settlement after
the period's fee accrued is the one that paid it. When only a later payout is found, the page
says "paid no later than".

Example (devnet, simulated participants): KITE `GTsckyDv…`, period 1 (met, paid at settlement)
and period 24 (bids 330 against a 400 minimum in all three checks; third failure in a row;
50% of the 400 USDC bond slashed).
