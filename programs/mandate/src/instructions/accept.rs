use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::*;
use crate::errors::MandateError;
use crate::events::MandateAccepted;
use crate::instructions::create::transfer_in;
use crate::state::*;

#[derive(Accounts)]
pub struct AcceptMandate<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(mut, constraint = mandate.status == MandateStatus::Open @ MandateError::InvalidStatus)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(
        init_if_needed,
        payer = maker,
        space = 8 + MakerProfile::INIT_SPACE,
        seeds = [MAKER_SEED, maker.key().as_ref()],
        bump
    )]
    pub maker_profile: Box<Account<'info, MakerProfile>>,
    #[account(mut, address = mandate.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// Must already hold every fee the maker could earn over the term.
    #[account(address = mandate.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = maker)]
    pub maker_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn accept_mandate(ctx: Context<AcceptMandate>) -> Result<()> {
    let maker = ctx.accounts.maker.key();
    let m = &mut ctx.accounts.mandate;
    if m.maker != Pubkey::default() {
        require_keys_eq!(m.maker, maker, MandateError::Unauthorized);
    }
    require_keys_neq!(m.issuer, maker, MandateError::Unauthorized);
    // A maker accepts a funded promise: the fee vault covers the whole term up front.
    require!(ctx.accounts.fee_vault.amount >= m.terms.max_fees()?, MandateError::UnderfundedFees);

    transfer_in(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.maker_quote,
        &ctx.accounts.bond_vault,
        &ctx.accounts.maker.to_account_info(),
        m.terms.bond_amount,
    )?;

    // Scoring starts after the setup window, so every period can be checked and paid.
    let now = Clock::get()?.unix_timestamp;
    m.maker = maker;
    m.status = MandateStatus::Active;
    m.start_ts = now.checked_add(SETUP_GRACE_SECS).ok_or(MandateError::MathOverflow)?;
    m.end_ts = m
        .start_ts
        .checked_add(m.terms.period_secs as i64 * m.terms.duration_periods as i64)
        .ok_or(MandateError::MathOverflow)?;
    m.current_period = 0;
    m.reset_period_accumulators();

    let p = &mut ctx.accounts.maker_profile;
    if p.maker == Pubkey::default() {
        p.maker = maker;
        p.bump = ctx.bumps.maker_profile;
    }
    p.mandates_accepted += 1;

    emit!(MandateAccepted { mandate: m.key(), maker, start_ts: m.start_ts, end_ts: m.end_ts });
    Ok(())
}
