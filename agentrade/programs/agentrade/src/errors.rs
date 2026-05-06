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
}
