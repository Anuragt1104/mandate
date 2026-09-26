//! Permissionless scoring. Anyone may take a snapshot at any time and as often as they
//! like; the maker cannot know when the issuer (or anyone else) will sample, so it must
//! keep its liquidity committed continuously. A period passes only if it was observed at
//! least once and every snapshot passed. Snapshots measure committed liquidity (see
//! `scoring.rs`), which trading against the position cannot change, so extra snapshots
//! cannot be used to fail an honest maker.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MandateError;
use crate::events::{MakerSlashed, MandateExpired, PeriodFinalized, SnapshotTaken};
use crate::anchor;
use crate::external::{damm_v2, dlmm};
use crate::math::{deviation_bps, price_from_bin_id};
use crate::scoring::{measure, BinAmounts, MeasureError, MeasureInput};
use crate::state::*;

/// Finalize every period that has fully elapsed at `now`, apply fees / failures / slashing,
/// and expire the mandate once its term is over.
pub fn finalize_through(m: &mut Mandate, mandate_key: Pubkey, log: &mut ScoreLog, profile: &mut MakerProfile, now: i64) -> Result<()> {
    if m.status != MandateStatus::Active {
        return Ok(());
    }
    let target = m.period_at(now).min(m.terms.duration_periods);
    let mut processed = 0u32;
    while m.status == MandateStatus::Active && m.current_period < target && processed < MAX_FINALIZE_PER_CALL {
        processed += 1;
        let status = if m.cur_snapshots == 0 {
            PERIOD_UNOBSERVED
        } else if m.cur_failed_snapshots > 0 {
            PERIOD_FAILED
        } else {
            PERIOD_OK
        };
        let mut fee = 0u64;
        match status {
            PERIOD_OK => {
                fee = m.terms.fee_per_period;
                m.fees_earned = m.fees_earned.saturating_add(fee);
                m.periods_ok += 1;
                m.consecutive_failed = 0;
                profile.periods_ok += 1;
                profile.fees_earned = profile.fees_earned.saturating_add(fee);
            }
            PERIOD_FAILED => {
                m.periods_failed += 1;
                m.consecutive_failed = m.consecutive_failed.saturating_add(1);
                profile.periods_failed += 1;
            }
            _ => m.periods_unobserved += 1,
        }
        log.push(PeriodEntry {
            period: m.current_period,
            status,
            snapshots: m.cur_snapshots.min(u8::MAX as u16) as u8,
            worst_spread_bps: m.cur_worst_spread_bps,
            min_bid_depth: if m.cur_snapshots == 0 { 0 } else { m.cur_min_bid_depth },
            min_ask_depth: if m.cur_snapshots == 0 { 0 } else { m.cur_min_ask_depth },
        });
        emit!(PeriodFinalized {
            mandate: mandate_key,
            period: m.current_period,
            status,
            snapshots: m.cur_snapshots,
            fee_accrued: fee,
        });

        if status == PERIOD_FAILED && m.consecutive_failed >= m.terms.max_consecutive_failures {
            let slashed = (m.terms.bond_amount as u128 * m.terms.slash_bps as u128 / MAX_BPS as u128) as u64;
            m.bond_slashed = slashed;
            m.status = MandateStatus::Breached;
            profile.mandates_breached += 1;
            profile.bond_slashed = profile.bond_slashed.saturating_add(slashed);
            emit!(MakerSlashed {
                mandate: mandate_key,
                maker: m.maker,
                amount: slashed,
                consecutive_failed: m.consecutive_failed,
            });
        }

        m.current_period += 1;
        m.reset_period_accumulators();
    }
    if m.status == MandateStatus::Active && now >= m.end_ts && m.current_period >= m.terms.duration_periods {
        m.status = MandateStatus::Expired;
        profile.mandates_completed += 1;
        emit!(MandateExpired { mandate: mandate_key });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.score_log)]
    pub score_log: AccountLoader<'info, ScoreLog>,
    #[account(mut, seeds = [MAKER_SEED, mandate.maker.as_ref()], bump = maker_profile.bump)]
    pub maker_profile: Box<Account<'info, MakerProfile>>,
    /// CHECK: must be the mandate's DLMM pair.
    #[account(address = mandate.lb_pair)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: must be the pair's oracle (source of the reference TWAP).
    #[account(address = mandate.oracle @ MandateError::OracleMismatch)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: must be the mandate's reference pool (informational deviation only).
    #[account(address = mandate.reference_pool)]
    pub reference_pool: UncheckedAccount<'info>,
    /// CHECK: the mandate's DLMM position; ignored when no position is open.
    pub position: UncheckedAccount<'info>,
}

pub fn snapshot<'info>(ctx: Context<'_, '_, 'info, 'info, Snapshot<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mandate_key = ctx.accounts.mandate.key();
    require!(ctx.accounts.mandate.status == MandateStatus::Active, MandateError::InvalidStatus);

    {
        let m = &mut ctx.accounts.mandate;
        let mut log = ctx.accounts.score_log.load_mut()?;
        finalize_through(m, mandate_key, &mut log, &mut ctx.accounts.maker_profile, now)?;
    }
    let m = &mut ctx.accounts.mandate;
    if m.status != MandateStatus::Active {
        return Ok(());
    }
    // Still catching up on elapsed periods: measure on a later call so the
    // snapshot is attributed to the right period.
    if m.current_period < m.period_at(now).min(m.terms.duration_periods) {
        return Ok(());
    }
    let pair = dlmm::read_lb_pair(&ctx.accounts.lb_pair)?;
    let sample = dlmm::read_oracle_latest(&ctx.accounts.oracle)?;
    anchor::refresh(m, sample, pair.bin_step, now);
    // Setup window: scoring starts at `start_ts`.
    if now < m.start_ts {
        return Ok(());
    }
    // Informational only, so it must never stop a check: an unreadable pool records
    // u16::MAX as the deviation.
    let damm_price = damm_v2::read_pool(&ctx.accounts.reference_pool)
        .and_then(|pool| damm_v2::reference_price(&pool, &m.base_mint, &m.quote_mint))
        .ok();
    let anchor_price = price_from_bin_id(m.anchor.bin, pair.bin_step).ok_or(MandateError::MathOverflow)?;

    // Position (optional).
    let (lower, upper, shares) = if m.position != Pubkey::default() {
        require_keys_eq!(ctx.accounts.position.key(), m.position, MandateError::PositionMismatch);
        let pos = dlmm::read_position(&ctx.accounts.position)?;
        require_keys_eq!(pos.lb_pair, m.lb_pair, MandateError::PositionMismatch);
        (pos.lower_bin_id, pos.upper_bin_id, dlmm::read_position_shares(&ctx.accounts.position)?)
    } else {
        (0, -1, Vec::new())
    };

    // Bin arrays supplied as remaining accounts (read-only).
    let mut arrays: Vec<(i64, Vec<BinAmounts>)> = Vec::with_capacity(ctx.remaining_accounts.len());
    for ai in ctx.remaining_accounts.iter() {
        let v = dlmm::read_bin_array(ai)?;
        require_keys_eq!(v.lb_pair, m.lb_pair, MandateError::InvalidAccountData);
        arrays.push((v.index, v.bins));
    }

    let c = measure(
        MeasureInput {
            anchor_bin: m.anchor.bin,
            bin_step: pair.bin_step,
            position: if m.position != Pubkey::default() { Some((lower, upper, &shares[..])) } else { None },
            bin_array: |idx| arrays.iter().find(|(i, _)| *i == idx).map(|(_, b)| &b[..]),
        },
        &m.terms,
    )
    .map_err(|e| match e {
        MeasureError::MissingBinArray(_) => error!(MandateError::MissingBinArray),
        MeasureError::Math => error!(MandateError::MathOverflow),
    })?;
    let measurement = Measurement {
        ts: now,
        ok: c.ok,
        spread_bps: c.spread_bps,
        bid_depth_quote: c.bid_depth_quote,
        ask_depth_quote: c.ask_depth_quote,
        ref_deviation_bps: damm_price.map_or(u16::MAX, |p| deviation_bps(anchor_price, p)),
        active_id: pair.active_id,
        anchor_bin: m.anchor.bin,
    };

    m.snapshots_total = m.snapshots_total.saturating_add(1);
    m.cur_snapshots = m.cur_snapshots.saturating_add(1);
    if !measurement.ok {
        m.cur_failed_snapshots = m.cur_failed_snapshots.saturating_add(1);
    }
    m.cur_worst_spread_bps = m.cur_worst_spread_bps.max(measurement.spread_bps);
    m.cur_min_bid_depth = m.cur_min_bid_depth.min(measurement.bid_depth_quote);
    m.cur_min_ask_depth = m.cur_min_ask_depth.min(measurement.ask_depth_quote);
    m.last = measurement;

    emit!(SnapshotTaken {
        mandate: mandate_key,
        period: m.current_period,
        ok: measurement.ok,
        spread_bps: measurement.spread_bps,
        bid_depth_quote: measurement.bid_depth_quote,
        ask_depth_quote: measurement.ask_depth_quote,
        ref_deviation_bps: measurement.ref_deviation_bps,
        active_id: measurement.active_id,
        anchor_bin: measurement.anchor_bin,
        cranker: ctx.accounts.cranker.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, address = mandate.score_log)]
    pub score_log: AccountLoader<'info, ScoreLog>,
    #[account(mut, seeds = [MAKER_SEED, mandate.maker.as_ref()], bump = maker_profile.bump)]
    pub maker_profile: Box<Account<'info, MakerProfile>>,
}

/// Permissionless: advance scoring through all elapsed periods (and expire if due).
/// Idempotent: on a mandate that is no longer active it does nothing, so a batch of
/// finalizes (or competing keepers) cannot roll back an earlier breach or expiry.
pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.mandate.key();
    let m = &mut ctx.accounts.mandate;
    if m.status != MandateStatus::Active {
        return Ok(());
    }
    let mut log = ctx.accounts.score_log.load_mut()?;
    finalize_through(m, key, &mut log, &mut ctx.accounts.maker_profile, now)
}
