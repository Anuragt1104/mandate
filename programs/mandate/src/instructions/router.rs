//! Meteora DBC integration. A launchpad sets its DBC config `leftover_receiver` to its
//! Router PDA. After a token graduates, DBC's permissionless `withdraw_leftover` pays the
//! unsold supply into the router's ATA; `route_leftover` then moves it into the mandate
//! vault registered for that mint, where it can only be used as mandated liquidity.
//!
//! If the mandate has already ended (cancelled before the leftover arrived, or breached,
//! expired or settled), `recover_leftover` sends the router's balance to the mandate's
//! issuer instead: the one beneficiary fixed at registration, so nobody (the launchpad
//! included) can redirect it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::MandateError;
use crate::events::{LeftoverRecovered, LeftoverRouted};
use crate::state::*;

#[derive(Accounts)]
pub struct InitRouter<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Router::INIT_SPACE,
        seeds = [ROUTER_SEED, authority.key().as_ref()], bump)]
    pub router: Box<Account<'info, Router>>,
    pub system_program: Program<'info, System>,
}

pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
    let r = &mut ctx.accounts.router;
    r.authority = ctx.accounts.authority.key();
    r.bump = ctx.bumps.router;
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterLaunch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ MandateError::Unauthorized)]
    pub router: Box<Account<'info, Router>>,
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(constraint = mandate.base_mint == base_mint.key() @ MandateError::LaunchMismatch)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(init, payer = authority, space = 8 + LaunchRecord::INIT_SPACE,
        seeds = [LAUNCH_SEED, router.key().as_ref(), base_mint.key().as_ref()], bump)]
    pub launch: Box<Account<'info, LaunchRecord>>,
    pub system_program: Program<'info, System>,
}

pub fn register_launch(ctx: Context<RegisterLaunch>) -> Result<()> {
    let l = &mut ctx.accounts.launch;
    l.router = ctx.accounts.router.key();
    l.base_mint = ctx.accounts.base_mint.key();
    l.mandate = ctx.accounts.mandate.key();
    l.bump = ctx.bumps.launch;
    ctx.accounts.router.launches += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct RouteLeftover<'info> {
    pub router: Box<Account<'info, Router>>,
    #[account(mut, has_one = router @ MandateError::LaunchMismatch, has_one = mandate @ MandateError::LaunchMismatch,
        seeds = [LAUNCH_SEED, router.key().as_ref(), mandate.base_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchRecord>>,
    #[account(constraint = matches!(mandate.status, MandateStatus::Open | MandateStatus::Active) @ MandateError::InvalidStatus)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = router)]
    pub router_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless.
pub fn route_leftover(ctx: Context<RouteLeftover>) -> Result<()> {
    let amount = ctx.accounts.router_base.amount;
    require!(amount > 0, MandateError::InsufficientVault);
    let r = &ctx.accounts.router;
    let seeds: &[&[u8]] = &[ROUTER_SEED, r.authority.as_ref(), &[r.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.router_base.to_account_info(),
                to: ctx.accounts.base_vault.to_account_info(),
                authority: ctx.accounts.router.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    let l = &mut ctx.accounts.launch;
    l.routed_amount = l.routed_amount.saturating_add(amount);
    emit!(LeftoverRouted { mandate: l.mandate, base_mint: l.base_mint, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct RecoverLeftover<'info> {
    pub router: Box<Account<'info, Router>>,
    #[account(mut, has_one = router @ MandateError::LaunchMismatch, has_one = mandate @ MandateError::LaunchMismatch,
        seeds = [LAUNCH_SEED, router.key().as_ref(), mandate.base_mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, LaunchRecord>>,
    #[account(constraint = !matches!(mandate.status, MandateStatus::Open | MandateStatus::Active) @ MandateError::InvalidStatus)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = router)]
    pub router_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = mandate.issuer)]
    pub issuer_base: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless: once the mandate has ended, leftover supply goes to its issuer.
pub fn recover_leftover(ctx: Context<RecoverLeftover>) -> Result<()> {
    let amount = ctx.accounts.router_base.amount;
    require!(amount > 0, MandateError::InsufficientVault);
    let r = &ctx.accounts.router;
    let seeds: &[&[u8]] = &[ROUTER_SEED, r.authority.as_ref(), &[r.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.router_base.to_account_info(),
                to: ctx.accounts.issuer_base.to_account_info(),
                authority: ctx.accounts.router.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    let l = &ctx.accounts.launch;
    emit!(LeftoverRecovered { mandate: l.mandate, base_mint: l.base_mint, to: ctx.accounts.issuer_base.key(), amount });
    Ok(())
}
