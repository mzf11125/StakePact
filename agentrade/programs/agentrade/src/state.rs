use anchor_lang::prelude::*;

/// Challenge window: 2 hours in seconds
pub const CHALLENGE_WINDOW: i64 = 7_200;

#[account]
pub struct ProgramConfig {
    pub oracle: Pubkey,
    pub pending_oracle: Pubkey,
    pub treasury: Pubkey,
    pub pyth_palm_oil_feed: Pubkey,
    pub bump: u8,
}

impl ProgramConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 1;
}

#[account]
pub struct Task {
    pub task_id: u64,
    pub operator: Pubkey,
    pub agent: Pubkey,
    pub bond_amount: u64,
    pub reward_amount: u64,
    pub description_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub status: TaskStatus,
    pub task_type: TaskType,
    pub deadline: i64,
    pub quality_score: u8,
    /// Unix timestamp when result was submitted — starts the challenge window
    pub submitted_at: i64,
    pub bump: u8,
}

impl Task {
    pub const LEN: usize = 8 + 8 + 32 + 32 + 8 + 8 + 32 + 32 + 1 + 1 + 8 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TaskStatus {
    Open,
    Accepted,
    Submitted,
    Disputed,   // someone posted a dispute bond
    Verified,
    Slashed,
}

/// PriceDiscovery tasks are verified against Pyth on-chain.
/// All other task types use the optimistic oracle (UMA-inspired):
///   submit → 2h challenge window → auto-settle OR dispute → oracle arbitrates.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TaskType {
    PriceDiscovery,
    DocumentVerification,
    LogisticsQuote,
    CustomsCheck,
}

#[account]
pub struct Dispute {
    pub task: Pubkey,
    pub disputer: Pubkey,
    pub bond_amount: u64,   // disputer's bond — slashed if dispute fails
    pub bump: u8,
}

impl Dispute {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
}

#[account]
pub struct AgentProfile {
    pub agent: Pubkey,
    pub operator: Pubkey,
    pub total_tasks: u32,
    pub completed_tasks: u32,
    pub slashed_tasks: u32,
    pub reliability_score: u8,
    pub bump: u8,
}

impl AgentProfile {
    pub const LEN: usize = 8 + 32 + 32 + 4 + 4 + 4 + 1 + 1;
}

#[account]
pub struct BondVault {
    pub task: Pubkey,
    pub bump: u8,
}

impl BondVault {
    pub const LEN: usize = 8 + 32 + 1;
}
