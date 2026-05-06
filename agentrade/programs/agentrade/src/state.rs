use anchor_lang::prelude::*;

#[account]
pub struct ProgramConfig {
    pub oracle: Pubkey,
    pub pending_oracle: Pubkey, // two-step oracle rotation — prevents single-key takeover
    pub treasury: Pubkey,
    pub bump: u8,
}

impl ProgramConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1;
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
    pub deadline: i64,
    pub quality_score: u8,
    pub bump: u8,
}

impl Task {
    pub const LEN: usize = 8 + 8 + 32 + 32 + 8 + 8 + 32 + 32 + 1 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TaskStatus {
    Open,
    Accepted,
    Submitted,
    Verified,
    Slashed,
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
