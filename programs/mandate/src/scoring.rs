//! Pure measurement logic: given DLMM pool state, the mandate's position and the
//! reference price, compute spread / depth / deviation and whether the terms are met.

use crate::constants::BINS_PER_ARRAY;
use crate::math::{base_to_quote, bin_array_index, deviation_bps, mul_div, price_from_bin_id};
use crate::state::{MandateTerms, Measurement};

#[derive(Clone, Copy, Default, Debug)]
pub struct BinAmounts {
    pub amount_x: u64,
    pub amount_y: u64,
    pub liquidity_supply: u128,
}

/// Minimal inputs, decoupled from account parsing so the logic is unit-testable.
pub struct MeasureInput<'a, F: Fn(i64) -> Option<&'a [BinAmounts]>> {
    pub active_id: i32,
    pub bin_step: u16,
    pub reference_price_q64: u128,
    /// (lower_bin_id, shares per bin) of the mandate position; None if no position.
    pub position: Option<(i32, i32, &'a [u128])>,
    pub bin_array: F,
}

pub enum MeasureError {
    MissingBinArray(i64),
    Math,
}

pub fn measure<'a, F>(input: MeasureInput<'a, F>, terms: &MandateTerms, now: i64) -> Result<Measurement, MeasureError>
where
    F: Fn(i64) -> Option<&'a [BinAmounts]>,
{
    let step = input.bin_step;
    let active = input.active_id;
    let p_active = price_from_bin_id(active, step).ok_or(MeasureError::Math)?;
    let ref_dev = deviation_bps(p_active, input.reference_price_q64);

    // Bins within the depth window: ceil(window_bps / bin_step).
    let window_bins = (terms.depth_window_bps as i32 + step as i32 - 1) / step.max(1) as i32;

    let mut best_bid: Option<i32> = None;
    let mut best_ask: Option<i32> = None;
    let mut bid_depth: u64 = 0;
    let mut ask_depth: u64 = 0;

    if let Some((lower, upper, shares)) = input.position {
        for bin in lower..=upper {
            let share = shares.get((bin - lower) as usize).copied().unwrap_or(0);
            if share == 0 {
                continue;
            }
            let idx = bin_array_index(bin);
            let arr = (input.bin_array)(idx).ok_or(MeasureError::MissingBinArray(idx))?;
            let b = *arr.get((bin as i64 - idx * BINS_PER_ARRAY as i64) as usize).ok_or(MeasureError::Math)?;
            if b.liquidity_supply == 0 {
                continue;
            }
            let x = mul_div(b.amount_x as u128, share, b.liquidity_supply).ok_or(MeasureError::Math)? as u64;
            let y = mul_div(b.amount_y as u128, share, b.liquidity_supply).ok_or(MeasureError::Math)? as u64;
            let in_window = (bin - active).abs() <= window_bins;

            if x > 0 && bin >= active {
                best_ask = Some(best_ask.map_or(bin, |a| a.min(bin)));
                if in_window {
                    let p = price_from_bin_id(bin, step).ok_or(MeasureError::Math)?;
                    ask_depth = ask_depth.saturating_add(base_to_quote(x, p).ok_or(MeasureError::Math)?);
                }
            }
            if y > 0 && bin <= active {
                best_bid = Some(best_bid.map_or(bin, |a| a.max(bin)));
                if in_window {
                    bid_depth = bid_depth.saturating_add(y);
                }
            }
        }
    }

    let spread_bps = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) if ask >= bid => {
            let s = (ask - bid) as u64 * step as u64;
            s.min(u16::MAX as u64) as u16
        }
        _ => u16::MAX,
    };

    let ok = input.position.is_some()
        && spread_bps <= terms.max_spread_bps
        && bid_depth >= terms.min_depth_quote
        && ask_depth >= terms.min_depth_quote
        && ref_dev <= terms.max_ref_deviation_bps;

    Ok(Measurement {
        ts: now,
        ok,
        spread_bps,
        bid_depth_quote: bid_depth,
        ask_depth_quote: ask_depth,
        ref_deviation_bps: ref_dev,
        active_id: active,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::ONE;

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
            max_ref_deviation_bps: 100,
            min_snapshot_interval_secs: 10,
            max_consecutive_failures: 3,
            slash_bps: 10_000,
        }
    }

    /// Position over bins [-5, 5] around active 0, bin_step 25 (0.25%), price ~1.
    fn book(bid_y: u64, ask_x: u64) -> ([BinAmounts; 70], [BinAmounts; 70], [u128; 70]) {
        let mut arr0 = [BinAmounts::default(); 70]; // index 0: bins 0..69
        let mut arr_m1 = [BinAmounts::default(); 70]; // index -1: bins -70..-1
        let mut shares = [0u128; 70];
        for bin in -5i32..=5 {
            let (arr, off) = if bin >= 0 { (&mut arr0, bin as usize) } else { (&mut arr_m1, (bin + 70) as usize) };
            let supply = 1_000_000u128;
            let (x, y) = match bin {
                0 => (ask_x / 2, bid_y / 2),
                b if b > 0 => (ask_x / 10, 0),
                _ => (0, bid_y / 10),
            };
            arr[off] = BinAmounts { amount_x: x, amount_y: y, liquidity_supply: supply };
            shares[(bin + 5) as usize] = supply; // position owns 100% of each bin
        }
        (arr0, arr_m1, shares)
    }

    #[test]
    fn compliant_book_passes() {
        let (a0, am1, shares) = book(10_000, 10_000);
        let m = measure(
            MeasureInput {
                active_id: 0,
                bin_step: 25,
                reference_price_q64: ONE,
                position: Some((-5, 5, &shares[..])),
                bin_array: |i| if i == 0 { Some(&a0[..]) } else if i == -1 { Some(&am1[..]) } else { None },
            },
            &terms(),
            1,
        )
        .ok()
        .unwrap();
        assert_eq!(m.spread_bps, 0, "active bin quotes both sides");
        assert!(m.bid_depth_quote >= 1_000 && m.ask_depth_quote >= 1_000);
        assert_eq!(m.ref_deviation_bps, 0);
        assert!(m.ok);
    }

    #[test]
    fn missing_side_fails() {
        let (a0, am1, shares) = book(10_000, 0);
        let m = measure(
            MeasureInput {
                active_id: 0,
                bin_step: 25,
                reference_price_q64: ONE,
                position: Some((-5, 5, &shares[..])),
                bin_array: |i| if i == 0 { Some(&a0[..]) } else if i == -1 { Some(&am1[..]) } else { None },
            },
            &terms(),
            1,
        )
        .ok()
        .unwrap();
        assert_eq!(m.spread_bps, u16::MAX);
        assert!(!m.ok);
    }

    #[test]
    fn reference_deviation_fails() {
        let (a0, am1, shares) = book(10_000, 10_000);
        let m = measure(
            MeasureInput {
                active_id: 0,
                bin_step: 25,
                reference_price_q64: ONE * 105 / 100, // DLMM is 4.8% below reference
                position: Some((-5, 5, &shares[..])),
                bin_array: |i| if i == 0 { Some(&a0[..]) } else if i == -1 { Some(&am1[..]) } else { None },
            },
            &terms(),
            1,
        )
        .ok()
        .unwrap();
        assert!(m.ref_deviation_bps > 400);
        assert!(!m.ok);
    }

    #[test]
    fn no_position_fails() {
        let m = measure(
            MeasureInput {
                active_id: 0,
                bin_step: 25,
                reference_price_q64: ONE,
                position: None,
                bin_array: |_| None,
            },
            &terms(),
            1,
        )
        .ok()
        .unwrap();
        assert!(!m.ok);
    }

    #[test]
    fn missing_bin_array_errors() {
        let (_a0, am1, shares) = book(10_000, 10_000);
        let r = measure(
            MeasureInput {
                active_id: 0,
                bin_step: 25,
                reference_price_q64: ONE,
                position: Some((-5, 5, &shares[..])),
                bin_array: |i| if i == -1 { Some(&am1[..]) } else { None },
            },
            &terms(),
            1,
        );
        assert!(matches!(r, Err(MeasureError::MissingBinArray(0))));
    }
}
