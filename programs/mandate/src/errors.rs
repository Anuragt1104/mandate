use anchor_lang::prelude::*;

#[error_code]
pub enum MandateError {
    #[msg("Invalid mandate parameters")]
    InvalidParams,
    #[msg("Mandate is not in the required status")]
    InvalidStatus,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Account is not owned by the expected program")]
    InvalidOwner,
    #[msg("Account data is malformed or has the wrong discriminator")]
    InvalidAccountData,
    #[msg("DLMM pair does not match the mandate base/quote mints (base must be token X)")]
    PairMintMismatch,
    #[msg("Reference pool does not match the mandate base/quote mints")]
    ReferenceMintMismatch,
    #[msg("Liquidity range is outside the allowed band around the reference price")]
    OutsideBand,
    #[msg("Quote may only be placed in bins at or below the reference price")]
    QuoteAboveReference,
    #[msg("Base may only be placed in bins at or above the reference price")]
    BaseBelowReference,
    #[msg("Oracle account does not match the DLMM pair")]
    OracleMismatch,
    #[msg("Liquidity range is outside the mandate position")]
    RangeOutsidePosition,
    #[msg("Mandate already has an open position")]
    PositionAlreadyOpen,
    #[msg("Mandate has no open position")]
    NoPosition,
    #[msg("Position account does not match the mandate")]
    PositionMismatch,
    #[msg("A required bin array was not supplied")]
    MissingBinArray,
    #[msg("Mandate is not active at this time")]
    NotActiveWindow,
    #[msg("Position still holds liquidity")]
    PositionNotEmpty,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Token account does not match the expected vault or owner")]
    InvalidTokenAccount,
    #[msg("Launch record does not match this mandate")]
    LaunchMismatch,
    #[msg("Insufficient vault balance")]
    InsufficientVault,
    #[msg("Liquidity was added too recently to be removed")]
    LiquidityCooldown,
}
