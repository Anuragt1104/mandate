use anchor_lang::prelude::*;

use crate::constants::SCORE_LOG_LEN;

/// Terms agreed between the issuer and the market maker. Immutable after creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MandateTerms {
    /// Quote paid to the maker for each compliant period.
    pub fee_per_period: u64,
    /// Length of a scoring period in seconds (e.g. 3600).
    pub period_secs: u32,
    /// Number of periods the mandate runs once accepted.
    pub duration_periods: u32,
    /// Quote the maker must post as a performance bond.
    pub bond_amount: u64,
    /// Max quoted spread around the reference price, in bps, measured at a size of
    /// `min_depth_quote / SPREAD_SIZE_DIVISOR` on each side.
    pub max_spread_bps: u16,
    /// Min committed liquidity (quote value) on each side within `depth_window_bps` of the reference.
    pub min_depth_quote: u64,
    /// Window around the reference price in which committed liquidity is counted, in bps.
    pub depth_window_bps: u16,
    /// Mandated liquidity may only be placed in bins priced within ±band of the reference price.
    pub band_bps: u16,
    /// Length of the DLMM oracle TWAP window the reference follows, in seconds.
    pub anchor_twap_secs: u32,
    /// Max speed at which the reference price may move toward the TWAP, in bps per minute.
    pub anchor_speed_bps_per_min: u16,
    /// Liquidity added while active must stay deployed at least this long before removal.
    pub liquidity_lock_secs: u32,
    /// Consecutive failed periods that trigger a slash.
    pub max_consecutive_failures: u16,
    /// Share of the bond transferred to the issuer on breach, in bps.
    pub slash_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
#[repr(u8)]
pub enum MandateStatus {
    /// Created and funded by the issuer; waiting for a maker.
    Open,
    /// Accepted by a maker; performance is being scored.
    Active,
    /// Maker breached the terms and was slashed; liquidity can be unwound by anyone.
    Breached,
    /// Term ended normally; liquidity can be unwound by anyone.
    Expired,
    /// Funds returned; terminal.
    Settled,
    /// Cancelled by the issuer before acceptance; terminal.
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Measurement {
    pub ts: i64,
    pub ok: bool,
    /// Quoted spread at size around the reference (u16::MAX when a side is missing).
    pub spread_bps: u16,
    /// Committed liquidity (quote value) at or below the reference, within the window.
    pub bid_depth_quote: u64,
    /// Committed liquidity (quote value) above the reference, within the window.
    pub ask_depth_quote: u64,
    /// Informational: reference price vs the DAMM v2 (graduation) pool price.
    pub ref_deviation_bps: u16,
    pub active_id: i32,
    pub anchor_bin: i32,
}

/// The mandate's reference price: a DLMM bin that follows the pair's oracle TWAP at a
/// bounded speed. See `anchor.rs`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Anchor {
    /// Reference bin; its DLMM price is the mandate's reference price.
    pub bin: i32,
    /// Latest TWAP bin the reference is moving toward.
    pub target: i32,
    /// Accrual clock for the speed limit.
    pub ts: i64,
    /// Oracle samples recorded before this time may include misattributed time.
    pub taint_ts: i64,
    /// TWAP window start (a DLMM oracle sample).
    pub start_cum: i128,
    pub start_ts: i64,
    /// Candidate for the next window start.
    pub next_cum: i128,
    pub next_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub version: u8,
    pub bump: u8,
    pub id: u64,
    pub issuer: Pubkey,
    pub maker: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lb_pair: Pubkey,
    /// The DLMM pair's oracle account (source of the TWAP).
    pub oracle: Pubkey,
    pub reference_pool: Pubkey,
    pub score_log: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub bond_vault: Pubkey,
    pub terms: MandateTerms,
    pub status: MandateStatus,

    /// DLMM position owned by this PDA (default when none is open).
    pub position: Pubkey,
    pub position_lower_bin_id: i32,
    pub position_width: i32,
    /// Who paid rent for the position (refunded on close).
    pub position_rent_payer: Pubkey,
    /// Last time the maker added liquidity; removals are blocked for
    /// `liquidity_lock_secs` afterwards so liquidity cannot be added just for a
    /// snapshot and pulled right after.
    pub last_liquidity_add_ts: i64,

    /// Reference price state.
    pub anchor: Anchor,

    pub created_at: i64,
    pub start_ts: i64,
    pub end_ts: i64,

    /// Period currently being observed (0-based, relative to `start_ts`).
    pub current_period: u32,
    pub cur_snapshots: u16,
    pub cur_failed_snapshots: u16,
    pub cur_worst_spread_bps: u16,
    pub cur_min_bid_depth: u64,
    pub cur_min_ask_depth: u64,

    /// Total snapshots taken over the mandate's life.
    pub snapshots_total: u32,
    pub periods_ok: u32,
    pub periods_failed: u32,
    pub periods_unobserved: u32,
    pub consecutive_failed: u16,

    pub fees_earned: u64,
    pub fees_claimed: u64,
    pub bond_slashed: u64,

    pub last: Measurement,
}

impl Mandate {
    pub fn is_scoring(&self) -> bool {
        self.status == MandateStatus::Active
    }

    /// Period index containing `now` (saturating at the final period).
    pub fn period_at(&self, now: i64) -> u32 {
        if now <= self.start_ts {
            return 0;
        }
        (((now - self.start_ts) as u64) / self.terms.period_secs as u64) as u32
    }

    pub fn reset_period_accumulators(&mut self) {
        self.cur_snapshots = 0;
        self.cur_failed_snapshots = 0;
        self.cur_worst_spread_bps = 0;
        self.cur_min_bid_depth = u64::MAX;
        self.cur_min_ask_depth = u64::MAX;
    }
}

#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct PeriodEntry {
    pub period: u32,
    /// 0 = empty, 1 = ok, 2 = failed, 3 = unobserved
    pub status: u8,
    pub snapshots: u8,
    pub worst_spread_bps: u16,
    pub min_bid_depth: u64,
    pub min_ask_depth: u64,
}

pub const PERIOD_EMPTY: u8 = 0;
pub const PERIOD_OK: u8 = 1;
pub const PERIOD_FAILED: u8 = 2;
pub const PERIOD_UNOBSERVED: u8 = 3;

/// Ring buffer of finalized periods, read by dashboards.
#[account(zero_copy)]
pub struct ScoreLog {
    pub mandate: Pubkey,
    pub head: u32,
    pub count: u32,
    pub entries: [PeriodEntry; SCORE_LOG_LEN],
}

impl ScoreLog {
    pub const SPACE: usize = 8 + 32 + 4 + 4 + SCORE_LOG_LEN * 24;

    pub fn push(&mut self, e: PeriodEntry) {
        let i = self.head as usize % SCORE_LOG_LEN;
        self.entries[i] = e;
        self.head = ((self.head as usize + 1) % SCORE_LOG_LEN) as u32;
        if (self.count as usize) < SCORE_LOG_LEN {
            self.count += 1;
        }
    }
}

/// Public track record of a market maker across all mandates.
#[account]
#[derive(InitSpace)]
pub struct MakerProfile {
    pub maker: Pubkey,
    pub bump: u8,
    pub mandates_accepted: u32,
    pub mandates_completed: u32,
    pub mandates_breached: u32,
    pub periods_ok: u64,
    pub periods_failed: u64,
    pub fees_earned: u64,
    pub bond_slashed: u64,
}

/// Launchpad router: set as the DBC config `leftover_receiver`, so unsold supply of every
/// token launched from that config lands in the router's ATAs and can be routed into the
/// token's mandate vault.
#[account]
#[derive(InitSpace)]
pub struct Router {
    pub authority: Pubkey,
    pub bump: u8,
    pub launches: u32,
}

/// Maps a launched base mint to the mandate that receives its leftover supply.
#[account]
#[derive(InitSpace)]
pub struct LaunchRecord {
    pub router: Pubkey,
    pub base_mint: Pubkey,
    pub mandate: Pubkey,
    pub routed_amount: u64,
    pub bump: u8,
}
