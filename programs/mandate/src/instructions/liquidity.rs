//! The restricted vault: inventory can only move into (and back out of) a DLMM position
//! owned by the mandate PDA, and only within the band around the reference price.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::MandateError;
use crate::events::{LiquidityDeployed, LiquidityWithdrawn};
use crate::external::damm_v2;
use crate::external::dlmm::{self, DlmmLiquidityAccounts, LiquidityParameterByStrategy, StrategyParameters, DLMM_EVENT_AUTHORITY};
use crate::math::{deviation_bps, price_from_bin_id, scale_bps};
use crate::mandate_signer_seeds;
use crate::state::*;

/// Maker-only while active; anyone may unwind once the mandate is breached or expired.
fn authorize_unwind(m: &Mandate, signer: &Pubkey) -> Result<()> {
    match m.status {
        MandateStatus::Active => require_keys_eq!(*signer, m.maker, MandateError::Unauthorized),
        MandateStatus::Breached | MandateStatus::Expired => {}
        _ => return err!(MandateError::InvalidStatus),
    }
    Ok(())
}

fn require_active_maker(m: &Mandate, signer: &Pubkey) -> Result<()> {
    require!(m.status == MandateStatus::Active, MandateError::InvalidStatus);
    require_keys_eq!(*signer, m.maker, MandateError::Unauthorized);
    let now = Clock::get()?.unix_timestamp;
    require!(now < m.end_ts, MandateError::NotActiveWindow);
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    /// CHECK: must be the mandate's DLMM pair.
    #[account(address = mandate.lb_pair)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: DLMM position PDA; seeds are enforced by DLMM.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: DLMM event authority.
    #[account(address = DLMM_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DLMM program.
    #[account(address = DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn open_position(ctx: Context<OpenPosition>, lower_bin_id: i32, width: i32) -> Result<()> {
    let m = &ctx.accounts.mandate;
    require_active_maker(m, &ctx.accounts.maker.key())?;
    require_keys_eq!(m.position, Pubkey::default(), MandateError::PositionAlreadyOpen);
    require!(width >= 1 && width <= MAX_POSITION_WIDTH, MandateError::InvalidParams);

    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    dlmm::initialize_position_pda(
        &ctx.accounts.dlmm_program.to_account_info(),
        &ctx.accounts.event_authority.to_account_info(),
        &ctx.accounts.maker.to_account_info(),
        &ctx.accounts.mandate.to_account_info(),
        &ctx.accounts.position.to_account_info(),
        &ctx.accounts.lb_pair.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.rent.to_account_info(),
        lower_bin_id,
        width,
        &[seeds],
    )?;

    let pos = dlmm::read_position(&ctx.accounts.position)?;
    let mandate_key = ctx.accounts.mandate.key();
    require_keys_eq!(pos.owner, mandate_key, MandateError::PositionMismatch);
    require_keys_eq!(pos.lb_pair, ctx.accounts.lb_pair.key(), MandateError::PositionMismatch);

    let m = &mut ctx.accounts.mandate;
    m.position = ctx.accounts.position.key();
    m.position_lower_bin_id = lower_bin_id;
    m.position_width = width;
    m.position_rent_payer = ctx.accounts.maker.key();
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ManageLiquidity<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    /// CHECK: must be the mandate's DLMM pair.
    #[account(mut, address = mandate.lb_pair)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: must be the mandate's reference pool.
    #[account(address = mandate.reference_pool)]
    pub reference_pool: UncheckedAccount<'info>,
    /// CHECK: must be the mandate's open DLMM position.
    #[account(mut, address = mandate.position @ MandateError::NoPosition)]
    pub position: UncheckedAccount<'info>,
    #[account(mut, address = mandate.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: validated against the LbPair reserves.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: validated against the LbPair reserves.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    #[account(address = mandate.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = mandate.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    /// CHECK: DLMM event authority.
    #[account(address = DLMM_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DLMM program.
    #[account(address = DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: SPL memo program (required by DLMM v2 withdraw/claim instructions).
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Owned AccountInfos so we can build `DlmmLiquidityAccounts` borrowing from them.
pub struct DlmmLiquidityAccountsOwned<'info> {
    pub dlmm_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub position: AccountInfo<'info>,
    pub lb_pair: AccountInfo<'info>,
    pub vault_x: AccountInfo<'info>,
    pub vault_y: AccountInfo<'info>,
    pub reserve_x: AccountInfo<'info>,
    pub reserve_y: AccountInfo<'info>,
    pub mint_x: AccountInfo<'info>,
    pub mint_y: AccountInfo<'info>,
    pub owner: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub memo_program: AccountInfo<'info>,
}

impl<'info> DlmmLiquidityAccountsOwned<'info> {
    fn from_ctx(a: &ManageLiquidity<'info>) -> Self {
        Self {
            dlmm_program: a.dlmm_program.to_account_info(),
            event_authority: a.event_authority.to_account_info(),
            position: a.position.to_account_info(),
            lb_pair: a.lb_pair.to_account_info(),
            vault_x: a.base_vault.to_account_info(),
            vault_y: a.quote_vault.to_account_info(),
            reserve_x: a.reserve_x.to_account_info(),
            reserve_y: a.reserve_y.to_account_info(),
            mint_x: a.base_mint.to_account_info(),
            mint_y: a.quote_mint.to_account_info(),
            owner: a.mandate.to_account_info(),
            token_program: a.token_program.to_account_info(),
            memo_program: a.memo_program.to_account_info(),
        }
    }

    fn borrow(&self) -> DlmmLiquidityAccounts<'_, 'info> {
        DlmmLiquidityAccounts {
            dlmm_program: &self.dlmm_program,
            event_authority: &self.event_authority,
            position: &self.position,
            lb_pair: &self.lb_pair,
            vault_x: &self.vault_x,
            vault_y: &self.vault_y,
            reserve_x: &self.reserve_x,
            reserve_y: &self.reserve_y,
            mint_x: &self.mint_x,
            mint_y: &self.mint_y,
            owner: &self.owner,
            token_program: &self.token_program,
            memo_program: &self.memo_program,
        }
    }
}

fn check_pair_accounts(a: &ManageLiquidity) -> Result<dlmm::LbPairView> {
    require_keys_neq!(a.mandate.position, Pubkey::default(), MandateError::NoPosition);
    let pair = dlmm::read_lb_pair(&a.lb_pair)?;
    require_keys_eq!(pair.reserve_x, a.reserve_x.key(), MandateError::InvalidTokenAccount);
    require_keys_eq!(pair.reserve_y, a.reserve_y.key(), MandateError::InvalidTokenAccount);
    Ok(pair)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AddLiquidityArgs {
    pub amount_base: u64,
    pub amount_quote: u64,
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    /// DLMM StrategyType (0..=8), e.g. 3 = SpotBalanced, 6 = SpotImBalanced.
    pub strategy_type: u8,
    pub max_active_bin_slippage: i32,
}

pub fn add_liquidity<'info>(ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>, args: AddLiquidityArgs) -> Result<()> {
    let a = &ctx.accounts;
    let m = &a.mandate;
    require_active_maker(m, &a.authority.key())?;
    let pair = check_pair_accounts(a)?;

    require!(args.strategy_type <= 8, MandateError::InvalidParams);
    require!(args.min_bin_id <= args.max_bin_id, MandateError::InvalidParams);
    let pos_upper = m.position_lower_bin_id + m.position_width - 1;
    require!(
        args.min_bin_id >= m.position_lower_bin_id && args.max_bin_id <= pos_upper,
        MandateError::RangeOutsidePosition
    );
    require!(
        args.amount_base <= a.base_vault.amount && args.amount_quote <= a.quote_vault.amount,
        MandateError::InsufficientVault
    );

    // Reference-price guards.
    let pool = damm_v2::read_pool(&a.reference_pool)?;
    let ref_price = damm_v2::reference_price(&pool, &m.base_mint, &m.quote_mint)?;
    let p_active = price_from_bin_id(pair.active_id, pair.bin_step).ok_or(MandateError::MathOverflow)?;
    require!(
        deviation_bps(p_active, ref_price) <= m.terms.max_ref_deviation_bps,
        MandateError::ReferenceDeviation
    );
    let lo = scale_bps(ref_price, m.terms.band_bps, false).ok_or(MandateError::MathOverflow)?;
    let hi = scale_bps(ref_price, m.terms.band_bps, true).ok_or(MandateError::MathOverflow)?;
    let p_min = price_from_bin_id(args.min_bin_id, pair.bin_step).ok_or(MandateError::MathOverflow)?;
    let p_max = price_from_bin_id(args.max_bin_id, pair.bin_step).ok_or(MandateError::MathOverflow)?;
    require!(p_min >= lo && p_max <= hi, MandateError::OutsideBand);

    let owned = DlmmLiquidityAccountsOwned::from_ctx(a);
    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    dlmm::add_liquidity_by_strategy2(
        &owned.borrow(),
        ctx.remaining_accounts,
        LiquidityParameterByStrategy {
            amount_x: args.amount_base,
            amount_y: args.amount_quote,
            active_id: pair.active_id,
            max_active_bin_slippage: args.max_active_bin_slippage,
            strategy_parameters: StrategyParameters {
                min_bin_id: args.min_bin_id,
                max_bin_id: args.max_bin_id,
                strategy_type: args.strategy_type,
                parameteres: [0u8; 64],
            },
        },
        &[seeds],
    )?;

    emit!(LiquidityDeployed {
        mandate: m.key(),
        amount_base: args.amount_base,
        amount_quote: args.amount_quote,
        min_bin_id: args.min_bin_id,
        max_bin_id: args.max_bin_id,
    });
    Ok(())
}

pub fn remove_liquidity<'info>(
    ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
    from_bin_id: i32,
    to_bin_id: i32,
    bps: u16,
    claim_fees: bool,
) -> Result<()> {
    let a = &ctx.accounts;
    let m = &a.mandate;
    authorize_unwind(m, &a.authority.key())?;
    check_pair_accounts(a)?;
    require!(bps > 0 && bps <= MAX_BPS && from_bin_id <= to_bin_id, MandateError::InvalidParams);

    let owned = DlmmLiquidityAccountsOwned::from_ctx(a);
    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    if claim_fees {
        let upper = m.position_lower_bin_id + m.position_width - 1;
        dlmm::claim_fee2(&owned.borrow(), ctx.remaining_accounts, m.position_lower_bin_id, upper, &[seeds])?;
    }
    dlmm::remove_liquidity_by_range2(&owned.borrow(), ctx.remaining_accounts, from_bin_id, to_bin_id, bps, &[seeds])?;

    emit!(LiquidityWithdrawn { mandate: m.key(), from_bin_id, to_bin_id, bps });
    Ok(())
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    /// CHECK: must be the mandate's open DLMM position.
    #[account(mut, address = mandate.position @ MandateError::NoPosition)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: receives the position rent; must be whoever paid it.
    #[account(mut, address = mandate.position_rent_payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// CHECK: DLMM event authority.
    #[account(address = DLMM_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DLMM program.
    #[account(address = DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
}

pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
    let m = &ctx.accounts.mandate;
    authorize_unwind(m, &ctx.accounts.authority.key())?;
    require_keys_neq!(m.position, Pubkey::default(), MandateError::NoPosition);
    require!(dlmm::position_is_empty(&ctx.accounts.position)?, MandateError::PositionNotEmpty);

    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    dlmm::close_position2(
        &ctx.accounts.dlmm_program.to_account_info(),
        &ctx.accounts.event_authority.to_account_info(),
        &ctx.accounts.position.to_account_info(),
        &ctx.accounts.mandate.to_account_info(),
        &ctx.accounts.rent_receiver.to_account_info(),
        &[seeds],
    )?;

    let m = &mut ctx.accounts.mandate;
    m.position = Pubkey::default();
    m.position_lower_bin_id = 0;
    m.position_width = 0;
    m.position_rent_payer = Pubkey::default();
    Ok(())
}
