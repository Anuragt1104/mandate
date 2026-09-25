# Mandate security model

Status: self-reviewed, not audited. Last review: 2026-09-25, program at commit `7214a02` and later.

Mandate holds an issuer's token inventory and a fee budget, and a market maker's bond. The
maker decides where the inventory is quoted on a Meteora DLMM pair. The program's job is to
make sure the maker can only use the inventory as honest two-sided quotes, and that
payment and slashing depend on facts nobody can fake at the moment of measurement.

## Roles

| Role | Can do | Cannot do |
|---|---|---|
| Issuer | create and fund a mandate, top it up, cancel it before acceptance, name a designated maker | withdraw inventory or fees during the term, touch the position, change terms |
| Maker | accept (posting the bond), open/close the mandate's DLMM position, add and remove liquidity within the rules, claim earned fees | move inventory anywhere except the mandate's own position and vaults, quote outside the band, bid above or offer below the reference |
| Anyone | snapshot, finalize periods, unwind and settle a breached or expired mandate, route DBC leftover | change who gets paid, or where funds go |
| Launchpad | create its router, register which mandate receives a token's DBC leftover | redirect leftover to anything but the registered mandate's base vault |

## What the program guarantees

1. **Inventory has one exit.** Vault tokens move only (a) into the DLMM position owned by the
   mandate PDA, via `add_liquidity`, (b) back from it into the same vaults, and (c) out at
   settlement to fixed recipients: inventory and unused fees to the issuer, earned fees and the
   unslashed bond to the maker, the slashed bond to the issuer.
   `instructions/liquidity.rs`, `instructions/settle.rs`. Test: "withdrawals can only return
   inventory to the vaults".
2. **Honest placement.** DLMM puts quote at or below the active bin and base at or above it.
   Mandate additionally requires that quote only goes into bins at or below the reference bin
   (+1 bin for rounding) and base only into bins at or above it, all within ±`band_bps`. A DLMM
   bin trades at one fixed price, so at placement the vault never buys above or sells below the
   reference. Tests: "the vault cannot bid above / offer below the reference price".
3. **Measurement that trading cannot move.** A snapshot values each of the position's bins as
   `P_bin · amount_x + amount_y`. A swap through a bin exchanges at exactly `P_bin`, so this
   value does not change (LP fees are tracked separately). Buying out the maker's asks before a
   snapshot changes the bins' composition but not the result. `scoring.rs`. Tests: unit
   `swaps_through_the_position_do_not_change_the_measurement` and integration "trading
   against the position right before a snapshot cannot fail a compliant maker".
4. **A reference that is expensive to move.** The reference bin follows the pair's DLMM oracle
   TWAP over at least `anchor_twap_secs` and moves at most `anchor_speed_bps_per_min`. After a
   long quiet spell the first move is capped at one minute's worth. `anchor.rs`. Tests:
   `tests/anchor.test.ts` and the unit tests in `anchor.rs`.
5. **Continuous obligation.** Anyone can snapshot at any time, as often as they like. A period
   pays only if it was observed and every snapshot in it passed. `max_consecutive_failures`
   failed periods in a row slash `slash_bps` of the bond and end the mandate.
6. **Liquidity lock.** Liquidity added during the term cannot be removed for
   `liquidity_lock_secs`, so a maker cannot add, snapshot and remove in one transaction.
7. **Unwinds cannot get stuck.** After a breach or expiry anyone can remove liquidity, claim LP
   fees (`bps = 0` claims only) and close the position, then settle.
8. **Bounded compute.** `finalize` processes at most 32 periods per call.
9. **No freezable inventory.** Base mints with a freeze authority are rejected.

## Findings from the review (fixed)

**F-1 Critical: anyone could fail an honest maker, and the issuer profited.**
Snapshots measured the live order book (spread and depth around the active bin). Buying out
the maker's asks, snapshotting and selling back failed the period. The cost was about twice
the DLMM fee on the ask inventory. For the issuer it was close to free, because those fees
accrue to the issuer's own vault, and after `max_consecutive_failures` periods the issuer
received the slashed bond. A snapshot rate limit made it worse: the attacker's snapshot also
blocked honest ones for the rest of the interval.
*Fix:* measure committed liquidity per bin (guarantee 3), and remove the rate limit.

**F-2 High: a maker could sell the vault's inventory to itself at a manufactured price.**
The band followed the DAMM v2 spot price at the moment of `add_liquidity`. In one transaction
a maker could push the DAMM v2 and DLMM prices up, place vault quote as bids at the
manipulated level, sell base into those bids and push the prices back. The only cost was
swap fees.
*Fix:* placement rule (guarantee 2) and a reference that ignores spot prices (guarantee 4).
Spot prices are no longer used for anything that is enforced.

**F-3 Medium: one party could control when everyone else observed.**
With a global minimum interval between snapshots, a maker running its own cranker could
snapshot the moment the interval expired, pull liquidity right after, and re-add just before
the next allowed snapshot. The result was 100% compliance with liquidity deployed about half
the time.
*Fix:* no rate limit. Snapshots cannot hurt an honest maker any more (F-1), so there is
nothing to protect.

**F-4 Medium (upstream behaviour): DLMM's oracle can be skewed with `go_to_a_bin`.**
`go_to_a_bin` is permissionless and moves the active bin across empty bins without updating
the oracle. The next swap credits the new bin for all the time since the previous oracle
update. Reproduced against the mainnet DLMM binary: after 600 idle seconds, emptying the edge
bins, jumping to bin 200 and swapping 1,000 atoms made the oracle report an average of about
bin 200 instead of bin 6. It needs an empty active bin. In a mandated pair the active bin
usually holds vault liquidity, which only the maker can remove.
*Fix:* when a removal during the term leaves the active bin empty, the mandate records a
taint. A TWAP window must start at an oracle sample recorded after the taint, so the skewed
interval is never used. The speed limit bounds anything else. Test: "an emptied active bin
taints the oracle".
Worth reporting upstream: `go_to_a_bin` could update the oracle before moving the active bin.

**F-5 Low: snapshots right after acceptance could fail the first period.**
Between `accept_mandate` and the maker's first deposit, a snapshot would fail period 0.
*Fix:* snapshots within 60 s of acceptance are ignored.

**F-6 Informational: unwinds needed a two-step dance when fees were unclaimed.**
DLMM refuses to close a position with unclaimed fees. Removing liquidity on an empty range
still works, so an unwind was never stuck, but it was not obvious.
*Fix:* `remove_liquidity` accepts `bps = 0` with `claim_fees` to claim only. Test: "a position
with unclaimed LP fees can still be unwound".

**F-7 Low: a freezable base mint let its authority stop the maker.**
Freezing the base vault blocks adds and removals, so the maker cannot follow the reference
and eventually fails, and the issuer collects the bond.
*Fix:* `create_mandate` rejects base mints with a freeze authority. DBC launches with
immutable authorities pass. The quote mint (for example USDC) is not restricted.

## Residual risks

- **Holding a manipulated price.** Moving the reference requires holding the DLMM price away
  from fair value for a meaningful part of the TWAP window. Arbitrageurs trade against that,
  which is the cost. In a pair with no arbitrage activity the cost can be low. The speed limit
  caps the damage at `anchor_speed_bps_per_min` per minute, and placement stays within ±band
  of wherever the reference is. Issuers should choose a conservative speed and a designated,
  bonded maker for thin markets. A bond at least as large as the plausible drift times the
  deployed inventory makes an attack unprofitable.
- **Third-party liquidity in the active bin.** If the active bin holds only other LPs'
  liquidity, they can empty it and reopen the F-4 gap without tainting. `go_to_a_bin` still
  cannot cross the vault's committed bins, so the jump is confined to gaps in the maker's
  quotes near the reference. The speed limit bounds the rest.
- **Nobody watching.** A period nobody observes is neither paid nor failed. A maker could add
  liquidity, snapshot it themselves, wait out the lock and remove it. Issuers should run a
  cranker, and the included keeper samples at random times.
- **Fee budget.** Fees earned beyond the fee vault's balance are not paid. Makers should
  check that the budget covers the term before accepting.
- **No early exits.** The maker cannot resign and the issuer cannot withdraw during the term.
  Both are deliberate for v1.
- **Token programs.** Only classic SPL Token mints are supported, for both base and quote.
- **Upgradeability.** The program is deployed upgradeable. Before mainnet use, the upgrade
  authority should be a multisig with a timelock, or revoked.
- **Not audited.** This is a self-review with tests. It is not a substitute for an audit.
