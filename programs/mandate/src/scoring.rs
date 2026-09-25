//! Pure measurement logic: how much liquidity has the maker committed around the
//! reference price, and does it meet the terms?
//!
//! Every bin of a DLMM position is a two-sided order at one fixed price: a swap through
//! bin `b` exchanges base for quote at exactly `P_b`, so the bin's value
//! `P_b · amount_x + amount_y` does not change (LP fees are tracked separately). The
//! measurement is therefore built on each bin's value rather than on the current book:
//! nobody can make a compliant maker fail, or a non-compliant one pass, by trading
//! against the position just before a snapshot. What counts is where the maker placed
//! the inventory:
//!
//! - bid side: bins at or below the reference bin, within the depth window
//! - ask side: bins above the reference bin, within the depth window
//! - spread: distance between the nearest bins, on each side, at which the cumulative
//!   committed value reaches `min_depth_quote / SPREAD_SIZE_DIVISOR`

use crate::constants::{BINS_PER_ARRAY, SPREAD_SIZE_DIVISOR};
use crate::math::{base_to_quote, bin_array_index, mul_div, price_from_bin_id};
use crate::state::MandateTerms;

#[derive(Clone, Copy, Default, Debug)]
pub struct BinAmounts {
    pub amount_x: u64,
    pub amount_y: u64,
    pub liquidity_supply: u128,
}

/// Minimal inputs, decoupled from account parsing so the logic is unit-testable.
pub struct MeasureInput<'a, F: Fn(i64) -> Option<&'a [BinAmounts]>> {
    pub anchor_bin: i32,
    pub bin_step: u16,
    /// (lower_bin_id, upper_bin_id, shares per bin) of the mandate position; None if none.
    pub position: Option<(i32, i32, &'a [u128])>,
    pub bin_array: F,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Committed {
    pub ok: bool,
    pub spread_bps: u16,
    pub bid_depth_quote: u64,
    pub ask_depth_quote: u64,
}

pub enum MeasureError {
    MissingBinArray(i64),
    Math,
}

pub fn measure<'a, F>(input: MeasureInput<'a, F>, terms: &MandateTerms) -> Result<Committed, MeasureError>
where
    F: Fn(i64) -> Option<&'a [BinAmounts]>,
{
    let step = input.bin_step.max(1);
    let window_bins = (terms.depth_window_bps as i32 + step as i32 - 1) / step as i32;
    let size = (terms.min_depth_quote / SPREAD_SIZE_DIVISOR).max(1);
    let anchor = input.anchor_bin;

    let mut bid_depth: u64 = 0;
    let mut ask_depth: u64 = 0;
    let mut bid_at_size: Option<i32> = None;
    let mut ask_at_size: Option<i32> = None;

    if let Some((lower, upper, shares)) = input.position {
        let committed = |bin: i32| -> Result<u64, MeasureError> {
            if bin < lower || bin > upper {
                return Ok(0);
            }
            let share = shares.get((bin - lower) as usize).copied().unwrap_or(0);
            if share == 0 {
                return Ok(0);
            }
            let idx = bin_array_index(bin);
            let arr = (input.bin_array)(idx).ok_or(MeasureError::MissingBinArray(idx))?;
            let b = *arr.get((bin as i64 - idx * BINS_PER_ARRAY as i64) as usize).ok_or(MeasureError::Math)?;
            if b.liquidity_supply == 0 {
                return Ok(0);
            }
            let p = price_from_bin_id(bin, step).ok_or(MeasureError::Math)?;
            let value = base_to_quote(b.amount_x, p).ok_or(MeasureError::Math)? as u128 + b.amount_y as u128;
            let mine = mul_div(value, share, b.liquidity_supply).ok_or(MeasureError::Math)?;
            Ok(mine.min(u64::MAX as u128) as u64)
        };

        for k in 0..=window_bins {
            let bin = anchor - k;
            bid_depth = bid_depth.saturating_add(committed(bin)?);
            if bid_at_size.is_none() && bid_depth >= size {
                bid_at_size = Some(bin);
            }
        }
        for k in 0..=window_bins {
            let bin = anchor + 1 + k;
            ask_depth = ask_depth.saturating_add(committed(bin)?);
            if ask_at_size.is_none() && ask_depth >= size {
                ask_at_size = Some(bin);
            }
        }
    }

    let spread_bps = match (bid_at_size, ask_at_size) {
        (Some(bid), Some(ask)) => ((ask - bid) as u64 * step as u64).min(u16::MAX as u64) as u16,
        _ => u16::MAX,
    };

    let ok = input.position.is_some()
        && spread_bps <= terms.max_spread_bps
        && bid_depth >= terms.min_depth_quote
        && ask_depth >= terms.min_depth_quote;

    Ok(Committed { ok, spread_bps, bid_depth_quote: bid_depth, ask_depth_quote: ask_depth })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> MandateTerms {
        MandateTerms {
            fee_per_period: 10,
            period_secs: 3600,
            duration_periods: 24,
            bond_amount: 1000,
            max_spread_bps: 100,
            min_depth_quote: 1_000,
            depth_window_bps: 200,
            band_bps: 500,
            anchor_twap_secs: 300,
            anchor_speed_bps_per_min: 100,
            liquidity_lock_secs: 10,
            max_consecutive_failures: 3,
            slash_bps: 10_000,
        }
    }

    type Arrays = ([BinAmounts; 70], [BinAmounts; 70]);

    fn set(arrays: &mut Arrays, bin: i32, b: BinAmounts) {
        if bin >= 0 {
            arrays.0[bin as usize] = b
        } else {
            arrays.1[(bin + 70) as usize] = b
        }
    }

    /// Position over bins [-5, 6], price ~1 around bin 0, bin_step 25. Bids hold quote,
    /// asks hold base; the position owns every bin entirely.
    fn book(bid_y: u64, ask_x: u64) -> (Arrays, [u128; 70]) {
        let mut a: Arrays = ([BinAmounts::default(); 70], [BinAmounts::default(); 70]);
        let mut shares = [0u128; 70];
        for bin in -5i32..=6 {
            let (x, y) = if bin <= 0 { (0, bid_y / 6) } else { (ask_x / 6, 0) };
            set(&mut a, bin, BinAmounts { amount_x: x, amount_y: y, liquidity_supply: 1_000_000 });
            shares[(bin + 5) as usize] = 1_000_000;
        }
        (a, shares)
    }

    fn run(a: &Arrays, shares: &[u128], anchor: i32) -> Committed {
        measure(
            MeasureInput {
                anchor_bin: anchor,
                bin_step: 25,
                position: Some((-5, 64, shares)),
                bin_array: |i| if i == 0 { Some(&a.0[..]) } else if i == -1 { Some(&a.1[..]) } else { None },
            },
            &terms(),
        )
        .ok()
        .unwrap()
    }

    #[test]
    fn compliant_book_passes() {
        let (a, shares) = book(12_000, 12_000);
        let m = run(&a, &shares, 0);
        assert_eq!(m.spread_bps, 25, "bins 0 and 1 are the nearest quotes");
        assert!(m.bid_depth_quote >= 1_000 && m.ask_depth_quote >= 1_000);
        assert!(m.ok);
    }

    #[test]
    fn swaps_through_the_position_do_not_change_the_measurement() {
        let (a, shares) = book(12_000, 12_000);
        let before = run(&a, &shares, 0);
        // A buyer takes every ask in bins 1..=3: each bin's base becomes quote at the
        // bin's own price.
        let mut swapped = a;
        for bin in 1..=3usize {
            let b = swapped.0[bin];
            let p = price_from_bin_id(bin as i32, 25).unwrap();
            swapped.0[bin] = BinAmounts { amount_x: 0, amount_y: b.amount_y + base_to_quote(b.amount_x, p).unwrap(), ..b };
        }
        let after = run(&swapped, &shares, 0);
        assert!(before.bid_depth_quote.abs_diff(after.bid_depth_quote) <= 3, "rounding only");
        assert!(before.ask_depth_quote.abs_diff(after.ask_depth_quote) <= 3, "rounding only");
        assert_eq!((before.ok, before.spread_bps), (after.ok, after.spread_bps));
    }

    #[test]
    fn missing_side_fails() {
        let (a, shares) = book(12_000, 0);
        let m = run(&a, &shares, 0);
        assert_eq!(m.spread_bps, u16::MAX);
        assert!(!m.ok);
    }

    #[test]
    fn quotes_far_from_the_reference_fail() {
        // Reference 20 bins up: the position is entirely on the bid side.
        let (a, shares) = book(12_000, 12_000);
        let m = run(&a, &shares, 20);
        assert_eq!(m.ask_depth_quote, 0);
        assert!(!m.ok);
    }

    #[test]
    fn dust_next_to_the_reference_does_not_tighten_the_spread() {
        let mut a: Arrays = ([BinAmounts::default(); 70], [BinAmounts::default(); 70]);
        let mut shares = [0u128; 70];
        // 1 unit at bins 0 and 1, real size only at -5 and 6.
        for (bin, x, y) in [(0, 0, 1), (1, 1, 0), (-5, 0, 5_000), (6, 5_000, 0)] {
            set(&mut a, bin, BinAmounts { amount_x: x, amount_y: y, liquidity_supply: 1 });
            shares[(bin + 5) as usize] = 1;
        }
        let m = run(&a, &shares, 0);
        assert_eq!(m.spread_bps, 11 * 25);
        assert!(!m.ok);
    }

    #[test]
    fn no_position_fails() {
        let m = measure(MeasureInput { anchor_bin: 0, bin_step: 25, position: None, bin_array: |_| None }, &terms())
            .ok()
            .unwrap();
        assert!(!m.ok);
    }

    #[test]
    fn missing_bin_array_errors() {
        let (a, shares) = book(12_000, 12_000);
        let r = measure(
            MeasureInput {
                anchor_bin: 0,
                bin_step: 25,
                position: Some((-5, 64, &shares[..])),
                bin_array: |i| if i == -1 { Some(&a.1[..]) } else { None },
            },
            &terms(),
        );
        assert!(matches!(r, Err(MeasureError::MissingBinArray(0))));
    }
}
