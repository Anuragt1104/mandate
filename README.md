# Mandate

Accountable liquidity management on Solana: hire a market maker without handing over your
tokens.

**Live app (Solana devnet):** https://mandate-lac-rho.vercel.app. The program is deployed on
devnet, where a simulated test network (a launchpad, token teams, three market makers of
different quality, traders, an attacker and a watchtower) runs on real contracts. The
participants are fictional and marked as simulated; it demonstrates the workflow, not
customer demand.

Token teams pay liquidity operators to keep their markets tradeable. Monitoring those
operators already exists; what doesn't is a way to hand over inventory without handing over
control, and to settle the agreement without trusting a monthly report. Mandate turns the
agreement into a Solana program:

- The **team** escrows token and quote inventory and a fee budget in vaults the program owns.
- An **operator** (usually one the team already works with, or any maker on an open offer)
  accepts the terms and posts a bond.
- The inventory can only be used as quotes on the token's **Meteora DLMM** pair: bids at or
  below a reference price, asks at or above it, inside a band the team sets.
- **Anyone** can check the operator's committed liquidity at any time. Every compliant period
  pays from the fee budget; consecutive failed periods slash the bond and end the agreement,
  and the inventory returns to the team.

What is enforced is *committed* liquidity near the reference price, valued bin by bin, so
trading against the book can't fake a pass or force a fail. What a trader can execute at a
given size moves with every trade; the app shows it next to the enforced measure, but it is not
the obligation. Both parties see the whole agreement in plain words before signing.

Launchpads can plug in through **Meteora's Dynamic Bonding Curve**: set the Mandate router as
the DBC `leftover_receiver`, and a graduating token's unsold supply moves into an agreement's
escrow as inventory instead of into a wallet. That funds the ask side only; the team or
launchpad still supplies quote tokens and a fee budget, and a maker has to accept.

## The workflow

The app is organised around a team that already pays an operator and is coming up for renewal:

1. **Monitor an existing arrangement.** Paste the pool or the operator's position. With no
   wallet and no deposit, the app samples the operator's DLMM liquidity at random times, measures
   it with the program's own arithmetic, and keeps the exact per-bin evidence. It reports
   periods met, missed, incomplete and unobserved; what traders could execute, separately;
   and when there's enough evidence to read it, and what is missing. The report is a shareable
   link. `scripts/verify.ts` does the same unattended for days; import its file under Reports.
2. **Draft with the operator.** Terms can start from what was observed. The feasibility preview
   shows what each side commits (inventory, the whole fee budget up front, the bond), how far
   the inventory stretches, a replay of each option against the observations, a separate what-if
   for reference moves, and what can't be concluded. Up to three versions compare side by side.
3. **Negotiate before money moves.** The draft travels as a private link. Either side proposes
   versions with a note; changes are highlighted by group (fee, bond, duration, reference,
   failure conditions). Each side approves by signing the exact terms hash with its wallet;
   only a version both signed can be funded, and it is funded exactly. `scripts/draft.ts` does
   the same with keypairs.
4. **Run and renew.** The agreement page shows the service live. Its renewal report answers
   "was it worth paying for?": periods, fees paid, unused budget and penalties kept apart,
   incidents with recovery times, inventory at the start and end, trader experience, and
   proposed changes tied to the evidence. "Renew with these changes" starts a new draft; live
   terms never change. When an agreement ends badly, the closing report records the handover:
   returned assets, the gap until the next agreement, and an invitation to a new operator.
5. **Operators get a work queue**: what needs attention, what changed since the last passing
   check, and a proposed action to simulate and approve, ranked with the watchtower's read.

Next steps and the evidence we still need are in [docs/validation.md](docs/validation.md).

## Repository layout

| Path | What it is |
|---|---|
| `programs/mandate` | The Anchor program (Rust). `anchor.rs` has the reference price, `scoring.rs` the measurement, and `instructions/` has one file per area |
| `sdk/src` | TypeScript client: PDAs, instruction builders, decoders, and a mirror of the reference-price logic |
| `tests` | Integration tests on LiteSVM with the **mainnet** DLMM, DAMM v2, DBC and Token Metadata binaries |
| `keeper` | `agents.ts` (maker, trader, watchtower and attacker behaviours) and single-purpose bots built on it: `cranker` (random-time checks, finalize, unwind and settle), `maker`, `trader` |
| `scripts` | `simulate.ts` (the simulated test network and replayable scenes), `demo.ts` (one launch-to-SLA flow), `lib/launch.ts` (Mandated DBC launch helpers), `localnet.sh`, `status.ts`, `liquidity-study.ts`, `fetch-programs.sh` |
| `app` | Next.js web app: network status board, SLA status pages (per-obligation uptime, incidents, committed book, routability, live activity, role-aware actions), maker ratings, Draft an SLA, Mandated DBC launch, liquidity study |
| `docs` | `security.md` (threat model and review findings), `spec/integration.md` (verified Meteora layouts and behaviour) |
| `tools` | Layout calculator and mainnet layout verifier for the Meteora accounts |

## Requirements

Rust 1.94, Solana CLI 3.1, Anchor 0.32.1, Node 22 or later.

## Build and test

```bash
npm install
```

```bash
./scripts/fetch-programs.sh
```

```bash
npm run build
```

```bash
npm run test:unit
```

```bash
npm test
```

`npm run build` runs `anchor build` and copies the IDL to `sdk/idl/`, which the app and bots
read. `fetch-programs.sh` downloads the mainnet Meteora programs into `fixtures/programs/`. It uses
`https://api.mainnet-beta.solana.com` unless `MAINNET_RPC` is set. The unit tests cover the
math, the reference price and the measurement, with fixtures shared with the SDK (26 tests).
`npm test` runs the full lifecycle, the reference price (including same-second taints), the
security regressions and the DBC → DAMM v2 → Mandate launch flow against the real Meteora
programs; checks that the SDK's measurement equals the program's atom for atom; and runs the
off-chain regression tests for the RPC proxy, model-answer validation, read provenance,
account chunking, event ingestion and the model worker (80 tests). CI
(`.github/workflows/ci.yml`) runs all of it, fails on SBF stack or syscall diagnostics, and
builds the app. `docs/reviews/` holds the external code review and what changed in response.

## Run it locally

Start a validator with the Meteora programs and the accounts they need (runs in the
foreground):

```bash
./scripts/localnet.sh
```

In another terminal, run the demo. It creates a DBC config whose leftover goes to a Mandate
router, launches a token, completes the curve, graduates to DAMM v2, creates a DLMM pair at
the graduated price, creates two mandates (one funded from the leftover and accepted, one
open), and writes `app/public/demo.json`. It uses `~/.config/solana/id.json` as the
launchpad and creates `.keys/maker.json` and `.keys/trader.json`.

```bash
npx tsx scripts/demo.ts
```

Start the bots. Replace `<MANDATE>` with the first address in `app/public/demo.json`.
The cranker needs a funded key; on localnet, airdrop to the key you pass as `KEYPAIR`.

```bash
KEYPAIR=.keys/maker.json MANDATE=<MANDATE> npx tsx keeper/maker.ts
```

```bash
KEYPAIR=.keys/trader.json MANDATE=<MANDATE> npx tsx keeper/trader.ts
```

```bash
npx tsx keeper/cranker.ts
```

Start the web app on http://localhost:3000. `app/.env.local` points it at the local
validator; see `app/.env.example`.

```bash
npm --prefix app install
```

```bash
npm --prefix app run build
```

```bash
npm --prefix app run start
```

On non-mainnet clusters the app offers a burner wallet and a "Get test SOL" button.

## How a mandate works

1. **Create.** The issuer picks the DLMM pair (base token = token X) and the graduated DAMM v2
   pool, deposits inventory and a fee budget, and sets the terms:
   - fee per period, period length and number of periods
   - bond and slash size, and how many failed periods in a row trigger a slash
   - max spread, min committed liquidity on each side, and the depth window
   - band, reference TWAP window and speed limit, and liquidity lock
2. **Accept.** A maker (or the designated maker) posts the bond. The fee vault must already
   hold every fee the maker could earn over the term, so a maker accepts a funded promise.
   Scoring starts after a one-minute setup window (`start_ts`), so every period can be paid.
3. **Quote.** The maker opens a DLMM position owned by the mandate PDA and deploys inventory:
   quote as bids at or below the reference, base as asks at or above it.
4. **Check.** Anyone calls `snapshot`. It refreshes the reference from the DLMM oracle and
   values the position's liquidity per bin around it: the reference bin and the whole bins
   within the depth window below it count as bids, the whole bins within the window above it
   as asks. It then checks the spread at size (10% of the depth target) and the committed
   liquidity on each side. The graduated pool's price is recorded for comparison only; if it
   can't be read, the check still runs.
5. **Score.** At each period boundary: observed with all checks passing pays
   `fee_per_period`; any failed check fails the period; no checks leaves it unobserved (no
   fee, no failure). `max_consecutive_failures` failed periods with no passing period between
   them slash the bond; unobserved periods neither reset nor add to that count.
6. **Settle.** After expiry or a breach, anyone unwinds the position and settles:
   - to the issuer: inventory and unused fees
   - to the maker: earned fees and the unslashed bond
   - to the issuer: the slashed part of the bond

   Tokens that reach a vault after settlement or cancellation can be swept by anyone to the
   same fixed recipients (`sweep`), and leftover launch supply that reaches the router after
   the mandate ended goes to its issuer (`recover_leftover`).

### The reference price

Spot prices can be pushed and pushed back inside one transaction, so none are used for
enforcement. The reference is a DLMM bin that follows the pair's oracle TWAP. It moves at
most `anchor_speed_bps_per_min`, and after a quiet spell by at most one minute's worth per
update. A maker removal that empties the active bin taints older oracle samples, because
DLMM's `go_to_a_bin` could otherwise skew the oracle; a sample stamped in the same second as
the removal counts as tainted too, and a full clean window must follow. The app shows when the
reference is warming, tainted or stale. `docs/security.md` explains why each
rule exists and what risk remains.

## Devnet

The program is deployed on devnet at `3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn`
([explorer](https://explorer.solana.com/address/3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn?cluster=devnet)),
with its IDL published on-chain. Meteora's DLMM, DAMM v2 and DBC run on devnet at their
mainnet addresses, but devnet only has DLMM presets for bin step 10, so the devnet demo
uses one of those. The public devnet RPC rate-limits hard and sometimes hangs on account
reads while answering everything else, so the scripts and the app fail over per method to a
second keyless devnet endpoint (`sdk/src/rpc.ts`). Add your own with `RPC_FALLBACKS` (scripts)
or `NEXT_PUBLIC_RPC_FALLBACKS` (app), comma-separated; a keyed provider as the primary is
better still.

```bash
CLUSTER=devnet RPC_URL=https://api.devnet.solana.com DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn npx tsx scripts/demo.ts
```

Off localnet the demo writes `app/public/demo.devnet.json` and keeps helper keys in
`.keys/devnet/`, reusing them on later runs. Point the bots at devnet with
`RPC_URL=https://api.devnet.solana.com`, and build the app with
`NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com NEXT_PUBLIC_CLUSTER=devnet`.

## The test network

`scripts/simulate.ts` stages a small economy on real contracts so the product can be watched
working. Every participant is fictional, marked **SIM** in the app, and listed in
`app/public/personas.<cluster>.json`; their transactions are real.

- **Nova Launchpad** launches ORBT and KITE on its Mandated DBC config; each graduates with an
  SLA funded from its leftover supply.
- **Helios Markets** quotes ORBT diligently. **Lazy Capital** takes KITE, quotes for a few
  minutes, then pulls its liquidity: checks fail, its bond is slashed, the watchtower settles.
  **Kite Protocol** re-tenders from its treasury and **Tidewater Trading** takes the offer.
- **Priya, Marco and Jun** trade small sizes, **Ferro Capital** trades blocks, **Mallory**
  buys out the asks and forces a check in the same transaction (it still passes), and the
  **Watchtower** checks every live SLA at random times.

```bash
npx tsx scripts/simulate.ts setup
```

```bash
npx tsx scripts/simulate.ts run
```

On devnet prefix both with `CLUSTER=devnet RPC_URL=https://api.devnet.solana.com
DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn`. Periods are one minute, so the
whole story plays out in about fifteen minutes. With `run` going, a scene replays a moment on
demand, for recording:

```bash
npx tsx scripts/simulate.ts scene walkaway 3
```

`walkaway [minutes]` posts a fresh KITE SLA that Lazy Capital quotes and then abandons (breach
and settlement follow in about four minutes); `sandwich` and `whale` run Mallory's attack and
a block trade on ORBT immediately.

## The sentinel: System One models in the watchtower

The watchtower is built as an observation service first: every active SLA gets at least one
check per period, spare checks go where rules expect failures, and every transaction has a
deadline. Jev, a System One decision model (typed answers with calibrated probabilities, no
generated text), runs in its own bounded queue on checks that already landed, so it can never
delay one. Its read (diagnosis, breach outlook, and whether the maker will fail to redeploy)
rides on the next check as a signed memo bound to the check it assessed; the app names the
model only for watchtowers it lists. Enforcement never depends on it, and it is optional: the
core is custody and settlement. [docs/sentinel.md](docs/sentinel.md) has the design, a
synthetic evaluation against rules with calibration, and the scheduling benchmark.

## Program

Program ID (localnet and devnet): `3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn`.

Meteora programs used (mainnet IDs, loaded locally from `fixtures/programs/`):

| Program | ID |
|---|---|
| DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |

| Instruction | Who | What |
|---|---|---|
| `create_mandate`, `deposit`, `cancel` | issuer | fund, top up, or cancel before acceptance |
| `accept_mandate` | maker | post the bond (fees for the whole term must be escrowed) and start the term after the setup window |
| `open_position`, `add_liquidity`, `remove_liquidity`, `close_position` | maker (anyone after breach or expiry for unwinding) | manage the mandate's DLMM position |
| `snapshot`, `finalize` | anyone | measure and score (`finalize` is a no-op once the mandate has ended) |
| `claim_maker_fees` | maker | withdraw earned fees |
| `settle` | anyone | distribute funds after breach or expiry |
| `init_router`, `register_launch` | launchpad | set up DBC leftover routing |
| `route_leftover` | anyone | move a graduated token's leftover into its mandate vault |
| `recover_leftover` | anyone | after the mandate has ended, send router-held leftover to its issuer |
| `sweep` | anyone | return tokens that reached a settled or cancelled mandate's vaults to fixed recipients |

## License

Apache-2.0. Meteora's SDKs used here are MIT/ISC. No code from Meteora's non-commercially
licensed program repositories is included; the mainnet binaries are downloaded for local
testing only.
