use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MandateError;
use crate::events::{MakerFeesClaimed, MandateSettled};
use crate::mandate_signer_seeds;
use crate::state::*;

pub fn transfer_out<'info>(
    token_program: &AccountInfo<'info>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    mandate: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program.clone(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: mandate.clone() },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct ClaimMakerFees<'info> {
    pub maker: Signer<'info>,
    #[account(mut, has_one = maker @ MandateError::Unauthorized)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = maker)]
    pub maker_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_maker_fees(ctx: Context<ClaimMakerFees>) -> Result<()> {
    let m = &ctx.accounts.mandate;
    require!(
        !matches!(m.status, MandateStatus::Open | MandateStatus::Cancelled | MandateStatus::Settled),
        MandateError::InvalidStatus
    );
    let owed = m.fees_earned.saturating_sub(m.fees_claimed);
    let amount = owed.min(ctx.accounts.fee_vault.amount);
    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    transfer_out(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.fee_vault,
        &ctx.accounts.maker_quote,
        &ctx.accounts.mandate.to_account_info(),
        seeds,
        amount,
    )?;
    let m = &mut ctx.accounts.mandate;
    m.fees_claimed = m.fees_claimed.saturating_add(amount);
    emit!(MakerFeesClaimed { mandate: m.key(), maker: m.maker, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.bond_vault)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = mandate.issuer)]
    pub issuer_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = mandate.issuer)]
    pub issuer_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = mandate.maker)]
    pub maker_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless once the mandate is breached or expired and the position is closed:
/// inventory and unused fees go back to the issuer, earned fees and the unslashed bond
/// go to the maker, and the slashed bond goes to the issuer.
pub fn settle(ctx: Context<Settle>) -> Result<()> {
    let a = &ctx.accounts;
    let m = &a.mandate;
    require!(
        matches!(m.status, MandateStatus::Breached | MandateStatus::Expired),
        MandateError::InvalidStatus
    );
    require_keys_eq!(m.position, Pubkey::default(), MandateError::PositionNotEmpty);

    let owed_fees = m.fees_earned.saturating_sub(m.fees_claimed).min(a.fee_vault.amount);
    let fee_rest = a.fee_vault.amount - owed_fees;
    let slashed = m.bond_slashed.min(a.bond_vault.amount);
    let bond_rest = a.bond_vault.amount - slashed;
    let base_all = a.base_vault.amount;
    let quote_all = a.quote_vault.amount;

    let tp = a.token_program.to_account_info();
    let mi = a.mandate.to_account_info();
    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    transfer_out(&tp, &a.base_vault, &a.issuer_base, &mi, seeds, base_all)?;
    transfer_out(&tp, &a.quote_vault, &a.issuer_quote, &mi, seeds, quote_all)?;
    transfer_out(&tp, &a.fee_vault, &a.maker_quote, &mi, seeds, owed_fees)?;
    transfer_out(&tp, &a.fee_vault, &a.issuer_quote, &mi, seeds, fee_rest)?;
    transfer_out(&tp, &a.bond_vault, &a.issuer_quote, &mi, seeds, slashed)?;
    transfer_out(&tp, &a.bond_vault, &a.maker_quote, &mi, seeds, bond_rest)?;

    let m = &mut ctx.accounts.mandate;
    m.fees_claimed = m.fees_claimed.saturating_add(owed_fees);
    m.status = MandateStatus::Settled;
    emit!(MandateSettled {
        mandate: m.key(),
        to_issuer_base: base_all,
        to_issuer_quote: quote_all + fee_rest + slashed,
        to_maker_quote: owed_fees + bond_rest,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub issuer: Signer<'info>,
    #[account(mut, has_one = issuer @ MandateError::Unauthorized,
        constraint = mandate.status == MandateStatus::Open @ MandateError::InvalidStatus)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = issuer)]
    pub issuer_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = issuer)]
    pub issuer_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let a = &ctx.accounts;
    let m = &a.mandate;
    let tp = a.token_program.to_account_info();
    let mi = a.mandate.to_account_info();
    mandate_signer_seeds!(m, id_bytes, bump, seeds);
    transfer_out(&tp, &a.base_vault, &a.issuer_base, &mi, seeds, a.base_vault.amount)?;
    transfer_out(&tp, &a.quote_vault, &a.issuer_quote, &mi, seeds, a.quote_vault.amount)?;
    transfer_out(&tp, &a.fee_vault, &a.issuer_quote, &mi, seeds, a.fee_vault.amount)?;
    ctx.accounts.mandate.status = MandateStatus::Cancelled;
    Ok(())
}
