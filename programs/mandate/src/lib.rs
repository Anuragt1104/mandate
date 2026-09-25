//! Mandate — enforceable designated-market-maker contracts on Solana.
//!
//! An issuer escrows token inventory and a fee budget. A market maker posts a bond and may
//! deploy the inventory *only* into a Meteora DLMM position owned by the mandate PDA, as
//! bids at or below and asks at or above a manipulation-resistant reference price (the
//! pair's oracle TWAP, speed-limited). Anyone can snapshot the committed liquidity;
//! compliant periods pay the maker, repeated failures slash the bond.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod anchor;
pub mod constants;
pub mod errors;
pub mod events;
pub mod external;
pub mod instructions;
pub mod math;
pub mod scoring;
pub mod state;

use instructions::*;

declare_id!("3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn");

/// Builds the mandate PDA signer seeds as `$seeds: &[&[u8]]`.
#[macro_export]
macro_rules! mandate_signer_seeds {
    ($m:expr, $id:ident, $bump:ident, $seeds:ident) => {
        let $id = $m.id.to_le_bytes();
        let $bump = [$m.bump];
        let $seeds: &[&[u8]] = &[
            $crate::constants::MANDATE_SEED,
            $m.issuer.as_ref(),
            $m.base_mint.as_ref(),
            &$id,
            &$bump,
        ];
    };
}

#[program]
pub mod mandate {
    use super::*;

    /// Issuer creates and funds a mandate over a DLMM pair, referenced to a DAMM v2 pool.
    pub fn create_mandate(ctx: Context<CreateMandate>, id: u64, args: CreateMandateArgs) -> Result<()> {
        instructions::create::create_mandate(ctx, id, args)
    }

    /// Top up inventory or the fee budget.
    pub fn deposit(ctx: Context<Deposit>, base: u64, quote: u64, fees: u64) -> Result<()> {
        instructions::create::deposit(ctx, base, quote, fees)
    }

    /// Issuer cancels before any maker accepts; all funds are returned.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::settle::cancel(ctx)
    }

    /// Market maker accepts the terms and posts the bond.
    pub fn accept_mandate(ctx: Context<AcceptMandate>) -> Result<()> {
        instructions::accept::accept_mandate(ctx)
    }

    /// Maker opens the DLMM position owned by the mandate PDA.
    pub fn open_position(ctx: Context<OpenPosition>, lower_bin_id: i32, width: i32) -> Result<()> {
        instructions::liquidity::open_position(ctx, lower_bin_id, width)
    }

    /// Maker deploys vault inventory into the position, within the reference band.
    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
        args: AddLiquidityArgs,
    ) -> Result<()> {
        instructions::liquidity::add_liquidity(ctx, args)
    }

    /// Withdraw liquidity back into the vaults (maker while active; anyone after).
    /// `bps = 0` with `claim_fees` only claims LP fees.
    pub fn remove_liquidity<'info>(
        ctx: Context<'_, '_, 'info, 'info, ManageLiquidity<'info>>,
        from_bin_id: i32,
        to_bin_id: i32,
        bps: u16,
        claim_fees: bool,
    ) -> Result<()> {
        instructions::liquidity::remove_liquidity(ctx, from_bin_id, to_bin_id, bps, claim_fees)
    }

    /// Close an empty position (maker while active; anyone after).
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::liquidity::close_position(ctx)
    }

    /// Permissionless: measure the maker's quotes and record compliance.
    pub fn snapshot<'info>(ctx: Context<'_, '_, 'info, 'info, Snapshot<'info>>) -> Result<()> {
        instructions::score::snapshot(ctx)
    }

    /// Permissionless: finalize elapsed periods, slash on breach, expire at term end.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        instructions::score::finalize(ctx)
    }

    /// Maker claims fees earned for compliant periods.
    pub fn claim_maker_fees(ctx: Context<ClaimMakerFees>) -> Result<()> {
        instructions::settle::claim_maker_fees(ctx)
    }

    /// Permissionless: distribute all funds once breached/expired and unwound.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::settle(ctx)
    }

    /// Launchpad creates its router (used as the DBC `leftover_receiver`).
    pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
        instructions::router::init_router(ctx)
    }

    /// Launchpad maps a launched mint to its mandate.
    pub fn register_launch(ctx: Context<RegisterLaunch>) -> Result<()> {
        instructions::router::register_launch(ctx)
    }

    /// Permissionless: move DBC leftover supply from the router into the mandate vault.
    pub fn route_leftover(ctx: Context<RouteLeftover>) -> Result<()> {
        instructions::router::route_leftover(ctx)
    }
}
