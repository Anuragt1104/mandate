# Mandate × Meteora — integration spec (verified)

Research date: 2026-09-25. Sources: `vendor/` clones of MeteoraAg repos (dlmm-sdk IDL v0.12.0, damm-v2 cp_amm v0.2.4, dynamic-bonding-curve), mainnet program dumps in `fixtures/programs/`, and live mainnet account reads (`tools/verify_layout.py`).

## Program IDs
| Program | ID |
|---|---|
| DLMM (lb_clmm) | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| DAMM v2 (cp_amm) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Metaplex Token Metadata (needed by DBC pool init) | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |

## DLMM — account layouts (byte offsets include the 8-byte discriminator)
Computed by `tools/layout.py` from the IDL (bytemuck repr(C), SBF alignment) and **verified against mainnet pool `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6` (SOL/USDC)**: 904 bytes, active_id/bin_step/mints/reserves/oracle decode correctly, price ≈ 117 USDC/SOL.

**LbPair** (904 bytes, disc `[33,11,49,98,181,101,177,13]`)
| field | offset | size |
|---|---|---|
| active_id (i32) | 76 | 4 |
| bin_step (u16) | 80 | 2 |
| status (u8) | 82 | 1 |
| token_x_mint | 88 | 32 |
| token_y_mint | 120 | 32 |
| reserve_x | 152 | 32 |
| reserve_y | 184 | 32 |
| oracle | 552 | 32 |
| token_mint_x_program_flag / y | 880 / 881 | 1 / 1 |

**PositionV2** (8120 bytes, disc `[117,176,212,199,245,180,133,182]`)
| field | offset | size |
|---|---|---|
| lb_pair | 8 | 32 |
| owner | 40 | 32 |
| liquidity_shares ([u128;70]) | 72 | 1120 |
| lower_bin_id (i32) | 7912 | 4 |
| upper_bin_id (i32) | 7916 | 4 |
| operator | 7960 | 32 |
| fee_owner | 8001 | 32 |

Positions wider than 70 bins store extra data after the fixed part ("dynamic positions"); v1 of Mandate caps width at 70.

**BinArray** (10136 bytes, disc `[92,142,92,220,5,148,70,181]`): index i64 @8, lb_pair @24, bins @56, 70 × Bin (144 bytes each). Within a Bin: amount_x u64 @0, amount_y u64 @8, price u128 (Q64.64) @16, liquidity_supply u128 @32.

## DLMM — math & PDAs
- Price (Q64.64, token_y atomic per token_x atomic) = `(1 + bin_step/10_000)^bin_id`, computed as `pow(ONE + (bin_step << 64)/10_000, bin_id)` (commons/src/math/price_math.rs).
- Bin array index = `floor(bin_id / 70)` (floor toward −∞). PDA seeds: `["bin_array", lb_pair, index i64 LE]`.
- Position PDA (initialize_position_pda): `["position", lb_pair, base, lower_bin_id i32 LE, width i32 LE]`, with `base` and `owner` both signers → Mandate PDA signs both via `invoke_signed`.
- Event authority: `["__event_authority"]` under DLMM.
- Default bitmap covers bin array indexes −512..511 (bin ids −35,840..35,839). Outside that the `bin_array_bitmap_extension` account is required.
- In DLMM, bins **below** the active bin hold token Y and bins **above** hold token X. Mandate v1 requires **base = X, quote = Y**, so asks (base) sit above the active bin and bids (quote) below.

## DLMM — instructions used via CPI (IDL v0.12.0)
| ix | discriminator | notes |
|---|---|---|
| initialize_position_pda | `[46,82,125,146,85,141,228,153]` | accts: payer(ws), base(s), position(w, pda), lb_pair, owner(s), system_program, rent, event_authority, program. args: lower_bin_id i32, width i32 |
| add_liquidity_by_strategy2 | `[3,221,149,218,111,141,118,213]` | accts: position(w), lb_pair(w), bin_array_bitmap_extension(opt), user_token_x(w), user_token_y(w), reserve_x(w), reserve_y(w), token_x_mint, token_y_mint, sender(s), token_x_program, token_y_program, event_authority, program; **remaining: transfer-hook accounts (per slices), then all covering bin arrays (writable)**. args: LiquidityParameterByStrategy{amount_x,amount_y,active_id,max_active_bin_slippage,strategy_parameters{min_bin_id,max_bin_id,strategy_type(u8 enum),parameteres[64]}}, RemainingAccountsInfo{slices: Vec} |
| remove_liquidity_by_range2 | `[204,2,195,145,53,145,145,205]` | same as above + memo_program before event_authority; args from_bin_id, to_bin_id, bps_to_remove u16, RemainingAccountsInfo |
| claim_fee2 | `[112,191,101,171,28,144,127,187]` | accts: lb_pair(w), position(w), sender(s), reserve_x, reserve_y, user_token_x, user_token_y, token_x_mint, token_y_mint, token_program_x, token_program_y, memo_program, event_authority, program; args min_bin_id, max_bin_id, RemainingAccountsInfo; remaining: bin arrays |
| close_position2 | `[174,90,35,115,186,40,147,226]` | accts: position(w), sender(s), rent_receiver(w), event_authority, program |

"Optional" Anchor accounts that are absent are passed as the DLMM program ID.
Strategy enum order: SpotOneSide=0, CurveOneSide, BidAskOneSide, SpotBalanced=3, CurveBalanced, BidAskBalanced, SpotImBalanced=6, CurveImBalanced, BidAskImBalanced.

## DLMM — pool creation for launches/tests
`initialize_lb_pair2` needs a `PresetParameter2` account. Mainnet presets saved to `fixtures/accounts/` (seeds `["preset_parameter2", index u16 LE]`): bin_step 10 → `5b2QSa3o…BqG`, 25 → `FxGzUdJZ…Yts`, 80 → `3PG2K7ja…hpE`, 100 → `BHheFrz5…Kdh`.

## DAMM v2 — reference price
**Pool** (1112 bytes, disc `[241,154,109,4,17,177,109,188]`): token_a_mint @168, token_b_mint @200, liquidity u128 @360, sqrt_min_price @424, sqrt_max_price @440, **sqrt_price u128 Q64.64 @456**, pool_status @481.
- DBC migration creates the DAMM v2 pool with **token_a = base, token_b = quote** (dynamic-bonding-curve `migrate_damm_v2_initialize_pool.rs` L183–184, L217–218, L389–390). So `price_quote_per_base (Q64.64) = sqrt_price² >> 64`.
- DAMM v2 has no on-chain TWAP. Mandate therefore (a) uses the graduated pool, whose liquidity is ≥10% permanently locked by DBC rules, as the reference; (b) requires |DLMM active price / reference − 1| ≤ `max_ref_deviation_bps` at every snapshot; and (c) bounds all mandated liquidity to a band around the reference.
- DAMM v2 configs that DBC uses for migration (pool_creator_authority = DBC pool authority) are saved in `fixtures/accounts/` (FixedBps25/30/100/200/400/600 and Customizable).

## DBC — what Mandate relies on
- `create_config` takes `leftover_receiver` as an **UncheckedAccount** (`ix_create_config.rs:24`), so any pubkey works, including a PDA.
- `withdraw_leftover` is **permissionless** (no signer) and pays to the **ATA of `leftover_receiver`** for the base mint, and only after migration reaches `CreatedPool` (`migration/withdraw_leftover.rs`). A config is shared by every pool created from it, so Mandate uses one **Router PDA per launchpad** as `leftover_receiver`, and a registered `mint → mandate` mapping to route each token's leftover into its mandate vault.
- Leftover only exists for **fixed-supply** configs (`tokenSupply` set).
- DBC pool init CPIs into Metaplex Token Metadata, so tests must load `mpl_token_metadata.so`.

## Local testing approach
Meteora's own DBC tests use **LiteSVM (npm `litesvm`) + mainnet `.so` fixtures** (`vendor/dynamic-bonding-curve/tests/utils`). Mandate uses the same approach: load `mandate.so`, `dlmm.so`, `damm_v2.so`, `dbc.so` and `mpl_token_metadata.so` at their mainnet IDs, inject preset/config accounts from `fixtures/accounts/*.json`, and control the clock with `setClock` to test hourly scoring periods.

## Open items / UNVERIFIED
- Whether mainnet DLMM rejects CPI `add_liquidity_by_strategy2` from a PDA sender (dlmm-sdk issue #114, "AccountBorrowFailed"). **This is the first thing the test suite checks.**
- The DBC fixed-supply config parameters (`tokenSupply`, `preMigrationTokenSupply`, `postMigrationTokenSupply`) that produce a non-zero leftover — to be confirmed in the launch test.
