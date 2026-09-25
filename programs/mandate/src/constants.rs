use anchor_lang::prelude::*;

pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub const MANDATE_SEED: &[u8] = b"mandate";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SCORE_LOG_SEED: &[u8] = b"score";
pub const MAKER_SEED: &[u8] = b"maker";
pub const ROUTER_SEED: &[u8] = b"router";
pub const LAUNCH_SEED: &[u8] = b"launch";

pub const VAULT_BASE: &[u8] = b"base";
pub const VAULT_QUOTE: &[u8] = b"quote";
pub const VAULT_FEE: &[u8] = b"fee";
pub const VAULT_BOND: &[u8] = b"bond";

/// Bins per DLMM bin array and max bins per (non-extended) DLMM position.
pub const BINS_PER_ARRAY: usize = 70;
pub const MAX_POSITION_WIDTH: i32 = 70;

/// Number of finalized periods kept in the on-chain score log ring buffer.
pub const SCORE_LOG_LEN: usize = 168;

pub const MIN_PERIOD_SECS: u32 = 60;
pub const MAX_BPS: u16 = 10_000;
