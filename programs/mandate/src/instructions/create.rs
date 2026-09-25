use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::MandateError;
use crate::events::MandateCreated;
use crate::external::{damm_v2, dlmm};
use crate::state::*;

pub fn validate_terms(t: &MandateTerms) -> Result<()> {
    require!(t.period_secs >= MIN_PERIOD_SECS, MandateError::InvalidParams);
    require!(t.duration_periods >= 1 && t.duration_periods <= 100_000, MandateError::InvalidParams);
    require!(t.max_spread_bps > 0, MandateError::InvalidParams);
    require!(t.depth_window_bps > 0 && t.depth_window_bps <= 5_000, MandateError::InvalidParams);
    require!(t.band_bps > 0 && t.band_bps <= 5_000, MandateError::InvalidParams);
    require!(t.max_ref_deviation_bps > 0 && t.max_ref_deviation_bps <= 5_000, MandateError::InvalidParams);
    require!(t.min_snapshot_interval_secs <= t.period_secs, MandateError::InvalidParams);
    require!(t.max_consecutive_failures >= 1, MandateError::InvalidParams);
    require!(t.slash_bps <= MAX_BPS, MandateError::InvalidParams);
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,

    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: validated as a DLMM LbPair with token_x = base, token_y = quote.
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: validated as a DAMM v2 pool over the same mints.
    pub reference_pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = issuer,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, issuer.key().as_ref(), base_mint.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub mandate: Box<Account<'info, Mandate>>,

    #[account(
        init,
        payer = issuer,
        space = ScoreLog::SPACE,
        seeds = [SCORE_LOG_SEED, mandate.key().as_ref()],
        bump
    )]
    pub score_log: AccountLoader<'info, ScoreLog>,

    #[account(init, payer = issuer, seeds = [VAULT_SEED, mandate.key().as_ref(), VAULT_BASE], bump,
        token::mint = base_mint, token::authority = mandate)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = issuer, seeds = [VAULT_SEED, mandate.key().as_ref(), VAULT_QUOTE], bump,
        token::mint = quote_mint, token::authority = mandate)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = issuer, seeds = [VAULT_SEED, mandate.key().as_ref(), VAULT_FEE], bump,
        token::mint = quote_mint, token::authority = mandate)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = issuer, seeds = [VAULT_SEED, mandate.key().as_ref(), VAULT_BOND], bump,
        token::mint = quote_mint, token::authority = mandate)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = base_mint, token::authority = issuer)]
    pub issuer_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = issuer)]
    pub issuer_quote: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMandateArgs {
    pub terms: MandateTerms,
    pub base_deposit: u64,
    pub quote_deposit: u64,
    pub fee_budget: u64,
    /// Restrict acceptance to one maker; `Pubkey::default()` lets any maker accept.
    pub designated_maker: Pubkey,
}

pub fn create_mandate(ctx: Context<CreateMandate>, id: u64, args: CreateMandateArgs) -> Result<()> {
    validate_terms(&args.terms)?;
    let base_key = ctx.accounts.base_mint.key();
    let quote_key = ctx.accounts.quote_mint.key();
    require_keys_neq!(base_key, quote_key, MandateError::InvalidParams);

    let pair = dlmm::read_lb_pair(&ctx.accounts.lb_pair)?;
    require!(
        pair.token_x_mint == base_key && pair.token_y_mint == quote_key,
        MandateError::PairMintMismatch
    );
    let pool = damm_v2::read_pool(&ctx.accounts.reference_pool)?;
    damm_v2::reference_price(&pool, &base_key, &quote_key)?;

    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.mandate;
    m.version = 1;
    m.bump = ctx.bumps.mandate;
    m.id = id;
    m.issuer = ctx.accounts.issuer.key();
    m.maker = args.designated_maker;
    m.base_mint = base_key;
    m.quote_mint = quote_key;
    m.lb_pair = ctx.accounts.lb_pair.key();
    m.reference_pool = ctx.accounts.reference_pool.key();
    m.score_log = ctx.accounts.score_log.key();
    m.base_vault = ctx.accounts.base_vault.key();
    m.quote_vault = ctx.accounts.quote_vault.key();
    m.fee_vault = ctx.accounts.fee_vault.key();
    m.bond_vault = ctx.accounts.bond_vault.key();
    m.terms = args.terms;
    m.status = MandateStatus::Open;
    m.position = Pubkey::default();
    m.created_at = now;
    m.reset_period_accumulators();

    {
        let mut log = ctx.accounts.score_log.load_init()?;
        log.mandate = m.key();
    }

    let tp = ctx.accounts.token_program.to_account_info();
    let issuer = ctx.accounts.issuer.to_account_info();
    transfer_in(&tp, &ctx.accounts.issuer_base, &ctx.accounts.base_vault, &issuer, args.base_deposit)?;
    transfer_in(&tp, &ctx.accounts.issuer_quote, &ctx.accounts.quote_vault, &issuer, args.quote_deposit)?;
    transfer_in(&tp, &ctx.accounts.issuer_quote, &ctx.accounts.fee_vault, &issuer, args.fee_budget)?;

    emit!(MandateCreated {
        mandate: m.key(),
        issuer: m.issuer,
        base_mint: base_key,
        quote_mint: quote_key,
        lb_pair: m.lb_pair,
        reference_pool: m.reference_pool,
        terms: m.terms,
        base_deposit: args.base_deposit,
        quote_deposit: args.quote_deposit,
        fee_budget: args.fee_budget,
    });
    Ok(())
}

pub fn transfer_in<'info>(
    token_program: &AccountInfo<'info>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            token_program.clone(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: authority.clone() },
        ),
        amount,
    )
}

// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(
        constraint = matches!(mandate.status, MandateStatus::Open | MandateStatus::Active) @ MandateError::InvalidStatus
    )]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.base_vault)]
    pub base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.quote_vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = mandate.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.base_mint, token::authority = depositor)]
    pub from_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mandate.quote_mint, token::authority = depositor)]
    pub from_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn deposit(ctx: Context<Deposit>, base: u64, quote: u64, fees: u64) -> Result<()> {
    let tp = ctx.accounts.token_program.to_account_info();
    let who = ctx.accounts.depositor.to_account_info();
    transfer_in(&tp, &ctx.accounts.from_base, &ctx.accounts.base_vault, &who, base)?;
    transfer_in(&tp, &ctx.accounts.from_quote, &ctx.accounts.quote_vault, &who, quote)?;
    transfer_in(&tp, &ctx.accounts.from_quote, &ctx.accounts.fee_vault, &who, fees)?;
    Ok(())
}
