use anchor_lang::prelude::*;

use crate::state::MandateTerms;

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub issuer: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lb_pair: Pubkey,
    pub reference_pool: Pubkey,
    pub terms: MandateTerms,
    pub base_deposit: u64,
    pub quote_deposit: u64,
    pub fee_budget: u64,
}

#[event]
pub struct MandateAccepted {
    pub mandate: Pubkey,
    pub maker: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct LiquidityDeployed {
    pub mandate: Pubkey,
    pub amount_base: u64,
    pub amount_quote: u64,
    pub min_bin_id: i32,
    pub max_bin_id: i32,
}

#[event]
pub struct LiquidityWithdrawn {
    pub mandate: Pubkey,
    pub from_bin_id: i32,
    pub to_bin_id: i32,
    pub bps: u16,
}

#[event]
pub struct SnapshotTaken {
    pub mandate: Pubkey,
    pub period: u32,
    pub ok: bool,
    pub spread_bps: u16,
    pub bid_depth_quote: u64,
    pub ask_depth_quote: u64,
    pub ref_deviation_bps: u16,
    pub active_id: i32,
    pub anchor_bin: i32,
    pub cranker: Pubkey,
}

#[event]
pub struct PeriodFinalized {
    pub mandate: Pubkey,
    pub period: u32,
    /// 1 ok, 2 failed, 3 unobserved
    pub status: u8,
    pub snapshots: u16,
    pub fee_accrued: u64,
}

#[event]
pub struct MakerSlashed {
    pub mandate: Pubkey,
    pub maker: Pubkey,
    pub amount: u64,
    pub consecutive_failed: u16,
}

#[event]
pub struct MandateExpired {
    pub mandate: Pubkey,
}

#[event]
pub struct MakerFeesClaimed {
    pub mandate: Pubkey,
    pub maker: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MandateSettled {
    pub mandate: Pubkey,
    pub to_issuer_base: u64,
    pub to_issuer_quote: u64,
    pub to_maker_quote: u64,
}

#[event]
pub struct LeftoverRecovered {
    pub mandate: Pubkey,
    pub base_mint: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultsSwept {
    pub mandate: Pubkey,
    pub to_issuer_base: u64,
    pub to_issuer_quote: u64,
    pub to_bond_owner: u64,
}

#[event]
pub struct LeftoverRouted {
    pub mandate: Pubkey,
    pub base_mint: Pubkey,
    pub amount: u64,
}
