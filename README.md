# Mandate

Designated market making, enforced on-chain.

**Live app (Solana devnet):** https://mandate-lac-rho.vercel.app. The program is deployed on
devnet, with a DBC-launched token whose mandate is actively quoted and scored.

Token issuers pay market makers to keep their markets liquid, but those contracts are
private, and nobody can check whether the maker delivered. Mandate turns the contract into a
Solana program:

- The **issuer** escrows token inventory and a fee budget in vaults owned by the program.
- A **market maker** accepts the terms and posts a bond.
- The inventory can only be used as quotes on the token's **Meteora DLMM** pair: bids at or
  below a reference price, asks at or above it, inside a band the issuer sets.
- **Anyone** can check the maker's committed liquidity at any time. Every compliant period
  pays the maker from the fee budget. Repeated failures slash the bond and end the mandate.

It plugs into **Meteora's Dynamic Bonding Curve**: a launchpad sets its Mandate router as
the DBC `leftover_receiver`. When a token graduates, its unsold supply is routed into that
token's mandate vault, so every token from that launchpad graduates with a market maker
under contract.

## Repository layout

| Path | What it is |
|---|---|
| `programs/mandate` | The Anchor program (Rust). `anchor.rs` has the reference price, `scoring.rs` the measurement, and `instructions/` has one file per area |
| `sdk/src` | TypeScript client: PDAs, instruction builders, decoders, and a mirror of the reference-price logic |
| `tests` | Integration tests on LiteSVM with the **mainnet** DLMM, DAMM v2, DBC and Token Metadata binaries |
| `keeper` | Bots: `cranker` (random-time snapshots, finalize, unwind and settle), `maker` (reference market maker), `trader` (random flow for demos) |
| `scripts` | `localnet.sh` (validator with Meteora programs), `demo.ts` (full launch-to-mandate flow), `status.ts`, `liquidity-study.ts`, `fetch-programs.sh` |
| `app` | Next.js web app: mandate board, mandate page (compliance tape, checks, depth ladder, role-aware actions), makers, create, Mandated DBC launch, liquidity study |
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
math, the reference price and the measurement (20 tests). The integration tests run the full
lifecycle, the reference price, the security regressions and the DBC → DAMM v2 → Mandate
launch flow against the real Meteora programs (37 tests).

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
2. **Accept.** A maker (or the designated maker) posts the bond. Scoring starts.
3. **Quote.** The maker opens a DLMM position owned by the mandate PDA and deploys inventory:
   quote as bids at or below the reference, base as asks at or above it.
4. **Check.** Anyone calls `snapshot`. It refreshes the reference from the DLMM oracle and
   values the position's liquidity per bin around it. It then checks the spread at size
   (10% of the depth target) and the committed liquidity on each side.
5. **Score.** At each period boundary: observed with all checks passing pays
   `fee_per_period`; any failed check fails the period; no checks leaves it unobserved (no
   fee, no failure). `max_consecutive_failures` failed periods in a row slash the bond.
6. **Settle.** After expiry or a breach, anyone unwinds the position and settles:
   - to the issuer: inventory and unused fees
   - to the maker: earned fees and the unslashed bond
   - to the issuer: the slashed part of the bond

### The reference price

Spot prices can be pushed and pushed back inside one transaction, so none are used for
enforcement. The reference is a DLMM bin that follows the pair's oracle TWAP. It moves at
most `anchor_speed_bps_per_min`, and after a quiet spell by at most one minute's worth per
update. A maker removal that empties the active bin taints older oracle samples, because
DLMM's `go_to_a_bin` could otherwise skew the oracle. `docs/security.md` explains why each
rule exists and what risk remains.

## Devnet

The program is deployed on devnet at `3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn`
([explorer](https://explorer.solana.com/address/3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn?cluster=devnet)),
with its IDL published on-chain. Meteora's DLMM, DAMM v2 and DBC run on devnet at their
mainnet addresses, but devnet only has DLMM presets for bin step 10, so the devnet demo
uses one of those. The public devnet RPC rate-limits hard; the scripts back off and retry.

```bash
CLUSTER=devnet RPC_URL=https://api.devnet.solana.com DLMM_PRESET=4vP4DFDJLRz85NBCfJALYPNdieWwzQSstrUuTms1gekn npx tsx scripts/demo.ts
```

Off localnet the demo writes `app/public/demo.devnet.json` and keeps helper keys in
`.keys/devnet/`, reusing them on later runs. Point the bots at devnet with
`RPC_URL=https://api.devnet.solana.com`, and build the app with
`NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com NEXT_PUBLIC_CLUSTER=devnet`.

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
| `accept_mandate` | maker | post the bond and start the term |
| `open_position`, `add_liquidity`, `remove_liquidity`, `close_position` | maker (anyone after breach or expiry for unwinding) | manage the mandate's DLMM position |
| `snapshot`, `finalize` | anyone | measure and score |
| `claim_maker_fees` | maker | withdraw earned fees |
| `settle` | anyone | distribute funds after breach or expiry |
| `init_router`, `register_launch` | launchpad | set up DBC leftover routing |
| `route_leftover` | anyone | move a graduated token's leftover into its mandate vault |

## License

Apache-2.0. Meteora's SDKs used here are MIT/ISC. No code from Meteora's non-commercially
licensed program repositories is included; the mainnet binaries are downloaded for local
testing only.
