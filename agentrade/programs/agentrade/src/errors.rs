use anchor_lang::prelude::*;

#[error_code]
pub enum AgenTradeError {
    #[msg("Task is not in the expected status")]
    InvalidStatus,
    #[msg("Deadline has not passed yet")]
    DeadlineNotPassed,
    #[msg("Task deadline has already passed")]
    DeadlinePassed,
    #[msg("Unauthorized: only the oracle can call this")]
    Unauthorized,
    #[msg("Quality score must be between 0 and 100")]
    InvalidScore,
    #[msg("Pyth price feed account is required for PriceDiscovery tasks")]
    MissingPythFeed,
    #[msg("agent_price_usd_cents is required for PriceDiscovery tasks")]
    MissingAgentPrice,
    #[msg("Invalid Pyth feed ID")]
    InvalidPythFeed,
    #[msg("Pyth price is stale (older than 60 seconds)")]
    StalePythPrice,
    #[msg("Challenge window has not expired yet")]
    ChallengeWindowOpen,
    #[msg("Challenge window has already expired")]
    ChallengeWindowExpired,
    #[msg("Task has already been disputed")]
    AlreadyDisputed,
}

