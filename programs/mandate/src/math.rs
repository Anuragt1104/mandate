//! Fixed-point helpers. Prices are Q64.64 (`ONE = 1 << 64`) expressed as
//! quote atomic units per base atomic unit, the same convention DLMM uses.

#![allow(clippy::manual_div_ceil)]

use uint::construct_uint;

construct_uint! {
    pub struct U256(4);
}

pub const SCALE_OFFSET: u32 = 64;
pub const ONE: u128 = 1u128 << SCALE_OFFSET;
pub const BPS: u128 = 10_000;
/// DLMM rejects exponents at or above 2^19 (see dlmm commons `MAX_EXPONENTIAL`).
const MAX_EXPONENTIAL: u32 = 0x80000;

/// `base^exp` in Q64.64 using exponentiation by squaring. Negative exponents are
/// computed as `1 / base^|exp|`. The base is inverted first when it is >= 1 so that
/// every intermediate product stays below 2^128 (same technique as DLMM's
/// `u64x64_math::pow`).
pub fn pow_q64(base: u128, exp: i32) -> Option<u128> {
    if exp == 0 {
        return Some(ONE);
    }
    let mut invert = exp.is_negative();
    let exp = exp.unsigned_abs();
    if exp >= MAX_EXPONENTIAL {
        return None;
    }
    let mut squared = base;
    if squared >= ONE {
        squared = u128::MAX.checked_div(squared)?;
        invert = !invert;
    }
    let mut result = ONE;
    let mut bit = 0u32;
    while (1u32 << bit) <= exp {
        if exp & (1 << bit) != 0 {
            result = result.checked_mul(squared)? >> SCALE_OFFSET;
        }
        squared = squared.checked_mul(squared)? >> SCALE_OFFSET;
        bit += 1;
    }
    if result == 0 {
        return None;
    }
    if invert {
        result = u128::MAX.checked_div(result)?;
    }
    Some(result)
}

/// DLMM bin price: (1 + bin_step / 10_000)^bin_id, Q64.64.
pub fn price_from_bin_id(bin_id: i32, bin_step: u16) -> Option<u128> {
    let bps = (u128::from(bin_step) << SCALE_OFFSET) / BPS;
    pow_q64(ONE.checked_add(bps)?, bin_id)
}

/// `a * b / d` with a 256-bit intermediate. Rounds down.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let r = U256::from(a).checked_mul(U256::from(b))? / U256::from(d);
    if r > U256::from(u128::MAX) {
        return None;
    }
    Some(r.as_u128())
}

/// Q64.64 price from a DAMM v2 Q64.64 sqrt price: sqrt^2 >> 64.
pub fn price_from_sqrt_q64(sqrt_price: u128) -> Option<u128> {
    let p = (U256::from(sqrt_price) * U256::from(sqrt_price)) >> SCALE_OFFSET;
    if p > U256::from(u128::MAX) {
        return None;
    }
    Some(p.as_u128())
}

/// Value `amount` base atomic units in quote atomic units at a Q64.64 price.
pub fn base_to_quote(amount: u64, price_q64: u128) -> Option<u64> {
    let v = (U256::from(amount) * U256::from(price_q64)) >> SCALE_OFFSET;
    if v > U256::from(u64::MAX) {
        return Some(u64::MAX);
    }
    Some(v.as_u64())
}

/// `a * b / d` rounded up.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let n = U256::from(a).checked_mul(U256::from(b))?;
    let d = U256::from(d);
    let r = (n + d - U256::one()) / d;
    if r > U256::from(u128::MAX) {
        return None;
    }
    Some(r.as_u128())
}

/// |a - b| / b in basis points, rounded up (conservative for compliance checks),
/// saturating at u16::MAX.
pub fn deviation_bps(a: u128, b: u128) -> u16 {
    if b == 0 {
        return u16::MAX;
    }
    let diff = a.abs_diff(b);
    match mul_div_ceil(diff, BPS, b) {
        Some(v) if v <= u16::MAX as u128 => v as u16,
        _ => u16::MAX,
    }
}

/// price * (10_000 ± bps) / 10_000
pub fn scale_bps(price: u128, bps: u16, up: bool) -> Option<u128> {
    let factor = if up {
        BPS + bps as u128
    } else {
        BPS.checked_sub(bps as u128)?
    };
    mul_div(price, factor, BPS)
}

/// Floor division toward negative infinity for the DLMM bin-array index.
pub fn bin_array_index(bin_id: i32) -> i64 {
    let b = bin_id as i64;
    let size = crate::constants::BINS_PER_ARRAY as i64;
    if b >= 0 {
        b / size
    } else {
        -((-b - 1) / size) - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_f64(q: u128) -> f64 {
        q as f64 / ONE as f64
    }

    #[test]
    fn pow_matches_float() {
        for (bin, step) in [(0, 10u16), (1, 10), (-1, 10), (100, 25), (-5358, 4), (2000, 80), (-2000, 80)] {
            let q = price_from_bin_id(bin, step).unwrap();
            let expect = (1.0 + step as f64 / 10_000.0).powi(bin);
            let got = to_f64(q);
            assert!((got - expect).abs() / expect < 1e-9, "bin {bin} step {step}: {got} vs {expect}");
        }
    }

    #[test]
    fn sol_usdc_mainnet_sample() {
        // Mainnet pool 5rCf1DM8…: active_id -5358, bin_step 4, SOL(9) / USDC(6) ≈ 117.33 USDC per SOL.
        let q = price_from_bin_id(-5358, 4).unwrap();
        let ui = to_f64(q) * 1e3; // * 10^(9-6)
        assert!((ui - 117.329).abs() < 0.01, "{ui}");
    }

    #[test]
    fn bin_array_index_floors() {
        assert_eq!(bin_array_index(0), 0);
        assert_eq!(bin_array_index(69), 0);
        assert_eq!(bin_array_index(70), 1);
        assert_eq!(bin_array_index(-1), -1);
        assert_eq!(bin_array_index(-70), -1);
        assert_eq!(bin_array_index(-71), -2);
    }

    #[test]
    fn helpers() {
        assert_eq!(deviation_bps(ONE * 101 / 100, ONE), 100);
        assert_eq!(deviation_bps(ONE, ONE), 0);
        assert_eq!(base_to_quote(1_000, ONE * 2), Some(2_000));
        assert_eq!(price_from_sqrt_q64(ONE * 3), Some(ONE * 9));
        assert_eq!(scale_bps(ONE, 200, true), Some(ONE * 102 / 100));
        assert_eq!(mul_div(u128::MAX, 2, 4), Some(u128::MAX / 2));
    }
}
