//! Read-only view over a Meteora DAMM v2 (cp_amm) pool, used as the reference price.
//! Offsets from the cp_amm IDL v0.2.4 (see docs/spec/integration.md).

use anchor_lang::prelude::*;

use crate::constants::DAMM_V2_PROGRAM_ID;
use crate::errors::MandateError;
use crate::math::price_from_sqrt_q64;

const POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const POOL_LEN: usize = 1112;

#[derive(Clone, Copy, Debug)]
pub struct DammPoolView {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub sqrt_price: u128,
    pub liquidity: u128,
}

pub fn read_pool(ai: &AccountInfo) -> Result<DammPoolView> {
    require_keys_eq!(*ai.owner, DAMM_V2_PROGRAM_ID, MandateError::InvalidOwner);
    let d = ai.try_borrow_data()?;
    require!(d.len() >= POOL_LEN && d[..8] == POOL_DISC, MandateError::InvalidAccountData);
    let pk = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
    let u128_at = |o: usize| u128::from_le_bytes(d[o..o + 16].try_into().unwrap());
    Ok(DammPoolView {
        token_a_mint: pk(168),
        token_b_mint: pk(200),
        liquidity: u128_at(360),
        sqrt_price: u128_at(456),
    })
}

/// Reference price (quote atomic per base atomic, Q64.64). DBC migrations create the
/// pool with token_a = base and token_b = quote; a reversed pool is inverted.
pub fn reference_price(view: &DammPoolView, base_mint: &Pubkey, quote_mint: &Pubkey) -> Result<u128> {
    let p = price_from_sqrt_q64(view.sqrt_price).ok_or(MandateError::MathOverflow)?;
    if view.token_a_mint == *base_mint && view.token_b_mint == *quote_mint {
        Ok(p)
    } else if view.token_a_mint == *quote_mint && view.token_b_mint == *base_mint {
        require!(p > 0, MandateError::MathOverflow);
        crate::math::mul_div(crate::math::ONE, crate::math::ONE, p).ok_or_else(|| MandateError::MathOverflow.into())
    } else {
        err!(MandateError::ReferenceMintMismatch)
    }
}
