//! Read-only views over Meteora DLMM zero-copy accounts and hand-built CPIs.
//!
//! Offsets are derived from the DLMM IDL (v0.12.0) with `tools/layout.py` and verified
//! against mainnet pool 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6. See
//! docs/spec/integration.md.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::{BINS_PER_ARRAY, DLMM_PROGRAM_ID, MEMO_PROGRAM_ID};
use crate::errors::MandateError;

pub const DLMM_EVENT_AUTHORITY: Pubkey = pubkey!("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");

const LB_PAIR_DISC: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const LB_PAIR_LEN: usize = 904;
const POSITION_V2_DISC: [u8; 8] = [117, 176, 212, 199, 245, 180, 133, 182];
const POSITION_V2_LEN: usize = 8120;
const BIN_ARRAY_DISC: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
const ORACLE_DISC: [u8; 8] = [139, 194, 131, 179, 140, 179, 229, 244];
/// Oracle header: discriminator + idx + active_size + length.
const ORACLE_HEADER: usize = 32;
/// Observation: cumulative_active_bin_id (i128), created_at (i64), last_updated_at (i64).
const OBSERVATION_SIZE: usize = 32;
const BIN_ARRAY_LEN: usize = 10136;
const BIN_SIZE: usize = 144;
const BINS_OFFSET: usize = 56;

const IX_INITIALIZE_POSITION_PDA: [u8; 8] = [46, 82, 125, 146, 85, 141, 228, 153];
const IX_ADD_LIQUIDITY_BY_STRATEGY2: [u8; 8] = [3, 221, 149, 218, 111, 141, 118, 213];
const IX_REMOVE_LIQUIDITY_BY_RANGE2: [u8; 8] = [204, 2, 195, 145, 53, 145, 145, 205];
const IX_CLAIM_FEE2: [u8; 8] = [112, 191, 101, 171, 28, 144, 127, 187];
const IX_CLOSE_POSITION2: [u8; 8] = [174, 90, 35, 115, 186, 40, 147, 226];

fn rd_i32(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn rd_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn rd_i128(d: &[u8], o: usize) -> i128 {
    i128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn rd_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn rd_pk(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn check(ai: &AccountInfo, disc: &[u8; 8], min_len: usize) -> Result<()> {
    require_keys_eq!(*ai.owner, DLMM_PROGRAM_ID, MandateError::InvalidOwner);
    let d = ai.try_borrow_data()?;
    require!(d.len() >= min_len && &d[..8] == disc, MandateError::InvalidAccountData);
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct LbPairView {
    pub active_id: i32,
    pub bin_step: u16,
    pub status: u8,
    pub token_x_mint: Pubkey,
    pub token_y_mint: Pubkey,
    pub reserve_x: Pubkey,
    pub reserve_y: Pubkey,
    pub oracle: Pubkey,
}

pub fn read_lb_pair(ai: &AccountInfo) -> Result<LbPairView> {
    check(ai, &LB_PAIR_DISC, LB_PAIR_LEN)?;
    let d = ai.try_borrow_data()?;
    Ok(LbPairView {
        active_id: rd_i32(&d, 76),
        bin_step: rd_u16(&d, 80),
        status: d[82],
        token_x_mint: rd_pk(&d, 88),
        token_y_mint: rd_pk(&d, 120),
        reserve_x: rd_pk(&d, 152),
        reserve_y: rd_pk(&d, 184),
        oracle: rd_pk(&d, 552),
    })
}

/// Latest observation of the pair's oracle, or None before the first swap.
pub fn read_oracle_latest(ai: &AccountInfo) -> Result<Option<crate::anchor::OracleSample>> {
    check(ai, &ORACLE_DISC, ORACLE_HEADER)?;
    let d = ai.try_borrow_data()?;
    let idx = rd_u64(&d, 8) as usize;
    let active_size = rd_u64(&d, 16);
    if active_size == 0 {
        return Ok(None);
    }
    let o = ORACLE_HEADER + idx * OBSERVATION_SIZE;
    require!(d.len() >= o + OBSERVATION_SIZE, MandateError::InvalidAccountData);
    Ok(Some(crate::anchor::OracleSample { cumulative: rd_i128(&d, o), ts: rd_i64(&d, o + 24) }))
}

#[derive(Clone, Copy, Debug)]
pub struct PositionView {
    pub lb_pair: Pubkey,
    pub owner: Pubkey,
    pub lower_bin_id: i32,
    pub upper_bin_id: i32,
}

pub fn read_position(ai: &AccountInfo) -> Result<PositionView> {
    check(ai, &POSITION_V2_DISC, POSITION_V2_LEN)?;
    let d = ai.try_borrow_data()?;
    Ok(PositionView {
        lb_pair: rd_pk(&d, 8),
        owner: rd_pk(&d, 40),
        lower_bin_id: rd_i32(&d, 7912),
        upper_bin_id: rd_i32(&d, 7916),
    })
}

/// Liquidity shares of the position for every bin in its (<=70 wide) range.
pub fn read_position_shares(ai: &AccountInfo) -> Result<Vec<u128>> {
    check(ai, &POSITION_V2_DISC, POSITION_V2_LEN)?;
    let d = ai.try_borrow_data()?;
    Ok((0..BINS_PER_ARRAY).map(|i| rd_u128(&d, 72 + i * 16)).collect())
}

pub use crate::scoring::BinAmounts;

pub struct BinArrayView {
    pub index: i64,
    pub lb_pair: Pubkey,
    /// Heap-allocated: 70 bins would not fit comfortably in an SBF stack frame.
    pub bins: Vec<BinAmounts>,
}

pub fn read_bin_array(ai: &AccountInfo) -> Result<BinArrayView> {
    check(ai, &BIN_ARRAY_DISC, BIN_ARRAY_LEN)?;
    let d = ai.try_borrow_data()?;
    let bins = (0..BINS_PER_ARRAY)
        .map(|i| {
            let o = BINS_OFFSET + i * BIN_SIZE;
            BinAmounts { amount_x: rd_u64(&d, o), amount_y: rd_u64(&d, o + 8), liquidity_supply: rd_u128(&d, o + 32) }
        })
        .collect();
    Ok(BinArrayView {
        index: rd_i64(&d, 8),
        lb_pair: rd_pk(&d, 24),
        bins,
    })
}

/// True if the position holds no liquidity shares in any bin.
pub fn position_is_empty(ai: &AccountInfo) -> Result<bool> {
    Ok(read_position_shares(ai)?.iter().all(|s| *s == 0))
}

// ---------------------------------------------------------------------------
// CPI argument types (Borsh layout must match the DLMM IDL exactly).
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct RemainingAccountsInfo {
    pub slices: Vec<RemainingAccountsSlice>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RemainingAccountsSlice {
    pub accounts_type: u8,
    pub length: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StrategyParameters {
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub strategy_type: u8,
    pub parameteres: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LiquidityParameterByStrategy {
    pub amount_x: u64,
    pub amount_y: u64,
    pub active_id: i32,
    pub max_active_bin_slippage: i32,
    pub strategy_parameters: StrategyParameters,
}

/// Accounts shared by every liquidity CPI. `owner` is the mandate PDA, which owns the
/// position and the vault token accounts.
pub struct DlmmLiquidityAccounts<'a, 'info> {
    pub dlmm_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub lb_pair: &'a AccountInfo<'info>,
    pub vault_x: &'a AccountInfo<'info>,
    pub vault_y: &'a AccountInfo<'info>,
    pub reserve_x: &'a AccountInfo<'info>,
    pub reserve_y: &'a AccountInfo<'info>,
    pub mint_x: &'a AccountInfo<'info>,
    pub mint_y: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub memo_program: &'a AccountInfo<'info>,
}

fn serialize<T: AnchorSerialize>(disc: [u8; 8], args: &T) -> Result<Vec<u8>> {
    let mut data = disc.to_vec();
    args.serialize(&mut data)?;
    Ok(data)
}

fn bin_array_metas(bin_arrays: &[AccountInfo]) -> Vec<AccountMeta> {
    bin_arrays.iter().map(|a| AccountMeta::new(*a.key, false)).collect()
}

fn infos<'info>(base: &[&AccountInfo<'info>], extra: &[AccountInfo<'info>]) -> Vec<AccountInfo<'info>> {
    let mut v: Vec<AccountInfo<'info>> = base.iter().map(|a| (*a).clone()).collect();
    v.extend(extra.iter().cloned());
    v
}

pub fn initialize_position_pda<'info>(
    dlmm_program: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    lb_pair: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    lower_bin_id: i32,
    width: i32,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = IX_INITIALIZE_POSITION_PDA.to_vec();
    lower_bin_id.serialize(&mut data)?;
    width.serialize(&mut data)?;
    let ix = Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            // `base` and `owner` are both the mandate PDA.
            AccountMeta::new_readonly(*owner.key, true),
            AccountMeta::new(*position.key, false),
            AccountMeta::new_readonly(*lb_pair.key, false),
            AccountMeta::new_readonly(*owner.key, true),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*rent.key, false),
            AccountMeta::new_readonly(*event_authority.key, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &infos(
            &[payer, owner, position, lb_pair, system_program, rent, event_authority, dlmm_program],
            &[],
        ),
        signer_seeds,
    )?;
    Ok(())
}

pub fn add_liquidity_by_strategy2<'info>(
    a: &DlmmLiquidityAccounts<'_, 'info>,
    bin_arrays: &[AccountInfo<'info>],
    params: LiquidityParameterByStrategy,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = serialize(IX_ADD_LIQUIDITY_BY_STRATEGY2, &params)?;
    RemainingAccountsInfo::default().serialize(&mut data)?;
    let mut accounts = vec![
        AccountMeta::new(*a.position.key, false),
        AccountMeta::new(*a.lb_pair.key, false),
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false), // bin_array_bitmap_extension: None
        AccountMeta::new(*a.vault_x.key, false),
        AccountMeta::new(*a.vault_y.key, false),
        AccountMeta::new(*a.reserve_x.key, false),
        AccountMeta::new(*a.reserve_y.key, false),
        AccountMeta::new_readonly(*a.mint_x.key, false),
        AccountMeta::new_readonly(*a.mint_y.key, false),
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.event_authority.key, false),
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
    ];
    accounts.extend(bin_array_metas(bin_arrays));
    let ix = Instruction { program_id: DLMM_PROGRAM_ID, accounts, data };
    invoke_signed(
        &ix,
        &infos(
            &[
                a.position, a.lb_pair, a.dlmm_program, a.vault_x, a.vault_y, a.reserve_x, a.reserve_y,
                a.mint_x, a.mint_y, a.owner, a.token_program, a.event_authority,
            ],
            bin_arrays,
        ),
        signer_seeds,
    )?;
    Ok(())
}

pub fn remove_liquidity_by_range2<'info>(
    a: &DlmmLiquidityAccounts<'_, 'info>,
    bin_arrays: &[AccountInfo<'info>],
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = IX_REMOVE_LIQUIDITY_BY_RANGE2.to_vec();
    from_bin_id.serialize(&mut data)?;
    to_bin_id.serialize(&mut data)?;
    bps_to_remove.serialize(&mut data)?;
    RemainingAccountsInfo::default().serialize(&mut data)?;
    let mut accounts = vec![
        AccountMeta::new(*a.position.key, false),
        AccountMeta::new(*a.lb_pair.key, false),
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        AccountMeta::new(*a.vault_x.key, false),
        AccountMeta::new(*a.vault_y.key, false),
        AccountMeta::new(*a.reserve_x.key, false),
        AccountMeta::new(*a.reserve_y.key, false),
        AccountMeta::new_readonly(*a.mint_x.key, false),
        AccountMeta::new_readonly(*a.mint_y.key, false),
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
        AccountMeta::new_readonly(*a.event_authority.key, false),
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
    ];
    accounts.extend(bin_array_metas(bin_arrays));
    let ix = Instruction { program_id: DLMM_PROGRAM_ID, accounts, data };
    invoke_signed(
        &ix,
        &infos(
            &[
                a.position, a.lb_pair, a.dlmm_program, a.vault_x, a.vault_y, a.reserve_x, a.reserve_y,
                a.mint_x, a.mint_y, a.owner, a.token_program, a.memo_program, a.event_authority,
            ],
            bin_arrays,
        ),
        signer_seeds,
    )?;
    Ok(())
}

pub fn claim_fee2<'info>(
    a: &DlmmLiquidityAccounts<'_, 'info>,
    bin_arrays: &[AccountInfo<'info>],
    min_bin_id: i32,
    max_bin_id: i32,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = IX_CLAIM_FEE2.to_vec();
    min_bin_id.serialize(&mut data)?;
    max_bin_id.serialize(&mut data)?;
    RemainingAccountsInfo::default().serialize(&mut data)?;
    let mut accounts = vec![
        AccountMeta::new(*a.lb_pair.key, false),
        AccountMeta::new(*a.position.key, false),
        AccountMeta::new_readonly(*a.owner.key, true),
        AccountMeta::new(*a.reserve_x.key, false),
        AccountMeta::new(*a.reserve_y.key, false),
        AccountMeta::new(*a.vault_x.key, false),
        AccountMeta::new(*a.vault_y.key, false),
        AccountMeta::new_readonly(*a.mint_x.key, false),
        AccountMeta::new_readonly(*a.mint_y.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(*a.token_program.key, false),
        AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
        AccountMeta::new_readonly(*a.event_authority.key, false),
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
    ];
    accounts.extend(bin_array_metas(bin_arrays));
    let ix = Instruction { program_id: DLMM_PROGRAM_ID, accounts, data };
    invoke_signed(
        &ix,
        &infos(
            &[
                a.lb_pair, a.position, a.owner, a.reserve_x, a.reserve_y, a.vault_x, a.vault_y, a.mint_x,
                a.mint_y, a.token_program, a.memo_program, a.event_authority, a.dlmm_program,
            ],
            bin_arrays,
        ),
        signer_seeds,
    )?;
    Ok(())
}

pub fn close_position2<'info>(
    dlmm_program: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
    position: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    rent_receiver: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*position.key, false),
            AccountMeta::new_readonly(*owner.key, true),
            AccountMeta::new(*rent_receiver.key, false),
            AccountMeta::new_readonly(*event_authority.key, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        ],
        data: IX_CLOSE_POSITION2.to_vec(),
    };
    invoke_signed(
        &ix,
        &infos(&[position, owner, rent_receiver, event_authority, dlmm_program], &[]),
        signer_seeds,
    )?;
    Ok(())
}
