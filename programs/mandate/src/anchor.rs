//! The mandate's reference price ("anchor").
//!
//! The anchor is a DLMM bin id. It follows the pair's time-weighted average active bin
//! (from Meteora's DLMM oracle), but can only move at `anchor_speed_bps_per_min`.
//!
//! Why not a spot price: any spot price (the DLMM active bin, a DAMM v2 pool) can be
//! pushed inside one transaction and pushed back. With a spot reference a maker could
//! place the issuer's inventory at a manipulated price and trade against it, and anyone
//! could move a compliant maker's quotes "out of range" at snapshot time. DLMM's oracle
//! accumulates `active_id × seconds` before every swap, so moving its average requires
//! holding the price, which arbitrageurs can trade against.
//!
//! One gap remains in the oracle itself. DLMM's permissionless `go_to_a_bin` moves the
//! active bin across empty bins without updating the oracle, and the next swap then
//! credits the new bin for all the time since the previous update (reproduced in
//! `tests/anchor.test.ts`). It needs an empty active bin. With a mandate in place that
//! usually means the maker removed the vault's liquidity there, so such removals
//! "taint" the oracle: a TWAP window must start at a sample recorded after the taint.
//! The speed limit bounds whatever is left.

use crate::state::{Anchor, Mandate};

/// Latest DLMM oracle observation: cumulative `active_id × seconds` and its timestamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleSample {
    pub cumulative: i128,
    pub ts: i64,
}

impl Anchor {
    pub fn new(active_id: i32, now: i64) -> Self {
        Anchor { bin: active_id, target: active_id, ts: now, ..Default::default() }
    }

    /// Record the latest oracle sample. Returns the TWAP bin once a full window of at
    /// least `twap_secs` is available after the last taint.
    pub fn observe(&mut self, sample: Option<OracleSample>, twap_secs: u32) -> Option<i32> {
        let s = sample?;
        if s.ts <= 0 {
            return None;
        }
        if self.start_ts < self.taint_ts {
            self.start_ts = 0;
            self.start_cum = 0;
        }
        if self.next_ts < self.taint_ts {
            self.next_ts = 0;
            self.next_cum = 0;
        }
        if s.ts < self.taint_ts {
            return None;
        }
        if self.next_ts == 0 {
            self.next_ts = s.ts;
            self.next_cum = s.cumulative;
        }
        if self.start_ts == 0 {
            self.start_ts = self.next_ts;
            self.start_cum = self.next_cum;
        }
        let window = twap_secs as i64;
        if s.ts - self.next_ts >= window {
            self.start_ts = self.next_ts;
            self.start_cum = self.next_cum;
            self.next_ts = s.ts;
            self.next_cum = s.cumulative;
        }
        let span = s.ts - self.start_ts;
        if span < window || span <= 0 {
            return None;
        }
        let avg = (s.cumulative - self.start_cum).div_euclid(span as i128);
        Some(avg.clamp(i32::MIN as i128, i32::MAX as i128) as i32)
    }

    /// Move toward `target` by at most `speed_bps_per_min` of accrued time. After a long
    /// quiet spell the first move is capped at one minute's worth, so a burst of calls in
    /// one transaction cannot spend hours of accrued allowance.
    pub fn step(&mut self, target: i32, now: i64, speed_bps_per_min: u16, bin_step: u16) {
        self.target = target;
        if target == self.bin {
            self.ts = now;
            return;
        }
        if now <= self.ts || speed_bps_per_min == 0 || bin_step == 0 {
            return;
        }
        let elapsed = (now - self.ts) as u128;
        let speed = speed_bps_per_min as u128;
        let secs_per_bin_num = 60u128 * bin_step as u128; // seconds per bin = num / speed
        let accrued = elapsed * speed / secs_per_bin_num;
        if accrued == 0 {
            return;
        }
        let cap = (speed / bin_step as u128).max(1);
        let gap = target.abs_diff(self.bin) as u128;
        let mv = if accrued >= cap {
            self.ts = now;
            cap.min(gap)
        } else if accrued >= gap {
            self.ts = now;
            gap
        } else {
            let used = (accrued * secs_per_bin_num).div_ceil(speed);
            self.ts += used as i64;
            accrued
        };
        let mv = mv as i32;
        self.bin = if target > self.bin { self.bin + mv } else { self.bin - mv };
    }

    /// Oracle samples recorded before `now` may contain misattributed time.
    pub fn taint(&mut self, now: i64) {
        self.taint_ts = self.taint_ts.max(now);
    }
}

/// Observe the oracle and move the mandate's reference toward the TWAP.
pub fn refresh(m: &mut Mandate, sample: Option<OracleSample>, bin_step: u16, now: i64) {
    if let Some(target) = m.anchor.observe(sample, m.terms.anchor_twap_secs) {
        m.anchor.step(target, now, m.terms.anchor_speed_bps_per_min, bin_step);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(cum: i128, ts: i64) -> Option<OracleSample> {
        Some(OracleSample { cumulative: cum, ts })
    }

    #[test]
    fn twap_needs_a_full_window() {
        let mut a = Anchor::new(0, 1_000);
        assert_eq!(a.observe(sample(0, 1_000), 300), None);
        // Active bin 10 for 200 s: window too short.
        assert_eq!(a.observe(sample(2_000, 1_200), 300), None);
        // 10 for 300 s after the first sample.
        assert_eq!(a.observe(sample(3_000, 1_300), 300), Some(10));
    }

    #[test]
    fn window_rolls_forward() {
        let mut a = Anchor::new(0, 0);
        a.observe(sample(0, 1_000), 300);
        assert_eq!(a.observe(sample(3_000, 1_300), 300), Some(10)); // bin 10 over [1000,1300]
        // Bin 20 over [1300,1600]: window is now [1300,1600].
        assert_eq!(a.observe(sample(9_000, 1_600), 300), Some(20));
    }

    #[test]
    fn negative_bins_round_down() {
        let mut a = Anchor::new(0, 0);
        a.observe(sample(0, 1_000), 100);
        // Average -2.5 rounds to -3 (floor).
        assert_eq!(a.observe(sample(-250, 1_100), 100), Some(-3));
    }

    #[test]
    fn taint_discards_earlier_samples() {
        let mut a = Anchor::new(0, 0);
        a.observe(sample(0, 1_000), 300);
        a.observe(sample(0, 1_300), 300);
        a.taint(1_400);
        // A sample recorded before the taint is ignored entirely.
        assert_eq!(a.observe(sample(0, 1_350), 300), None);
        // The first sample after the taint may include misattributed time: it can only
        // start a window, never end one.
        assert_eq!(a.observe(sample(120_000, 1_400), 300), None);
        assert_eq!(a.start_ts, 1_400);
        assert_eq!(a.observe(sample(120_000 + 5 * 300, 1_700), 300), Some(5));
    }

    #[test]
    fn step_is_speed_limited() {
        // bin_step 25, 100 bps/min => 4 bins per minute, cap 4 bins.
        let mut a = Anchor::new(0, 0);
        a.step(100, 30, 100, 25);
        assert_eq!(a.bin, 2, "30 s at 4 bins/min");
        a.step(100, 30, 100, 25);
        assert_eq!(a.bin, 2, "no time, no move");
        a.step(100, 45, 100, 25);
        assert_eq!(a.bin, 3);
    }

    #[test]
    fn long_idle_moves_at_most_the_cap() {
        let mut a = Anchor::new(0, 0);
        a.step(1_000, 3_600, 100, 25);
        assert_eq!(a.bin, 4, "one minute's worth after an hour idle");
        a.step(1_000, 3_600, 100, 25);
        assert_eq!(a.bin, 4, "a second call in the same second does not move");
    }

    #[test]
    fn slow_speed_still_moves_one_bin_at_a_time() {
        // 10 bps/min with 25 bps bins: one bin every 150 s.
        let mut a = Anchor::new(0, 0);
        a.step(-5, 100, 10, 25);
        assert_eq!(a.bin, 0);
        a.step(-5, 150, 10, 25);
        assert_eq!(a.bin, -1);
    }

    #[test]
    fn reaching_the_target_resets_the_clock() {
        let mut a = Anchor::new(0, 0);
        a.step(2, 60, 100, 25);
        assert_eq!((a.bin, a.ts), (2, 60));
    }
}
