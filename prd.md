Here's everything — architecture first, then the contract, then your day-by-day plan.

**The system has three layers:** external actors at the top, the Solana program in the middle, and protocol integrations at the bottom. Here's how they connect:Now here's the full Anchor program structure. This is the core you need to write — everything else (frontend, API) wraps around it.

**State accounts:**

```rust
// programs/stakepact/src/state.rs

#[account]
pub struct Task {
    pub task_id: u64,
    pub operator: Pubkey,       // who created the task
    pub agent: Pubkey,          // who claimed it
    pub bond_amount: u64,       // SOL locked (lamports)
    pub reward_amount: u64,     // SOL paid on success
    pub description_hash: [u8; 32], // IPFS CID of task brief
    pub result_hash: [u8; 32],      // IPFS CID of submitted output
    pub status: TaskStatus,
    pub deadline: i64,
    pub quality_score: u8,      // 0–100 from judge oracle
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TaskStatus {
    Open,
    Accepted,
    Submitted,
    Verified,   // success path
    Slashed,    // failure path
}

#[account]
pub struct AgentProfile {
    pub agent: Pubkey,
    pub operator: Pubkey,
    pub total_tasks: u32,
    pub completed_tasks: u32,
    pub slashed_tasks: u32,
    pub reliability_score: u8,  // (completed / total) * 100
    pub bump: u8,
}

#[account]
pub struct BondVault {
    pub task: Pubkey,
    pub bump: u8,
    // SOL held natively — no token account needed
}
```

**Program instructions:**

```rust
// programs/stakepact/src/lib.rs

pub fn create_task(
    ctx: Context<CreateTask>,
    task_id: u64,
    bond_amount: u64,
    reward_amount: u64,
    description_hash: [u8; 32],
    deadline: i64,
) -> Result<()>

pub fn accept_task(
    ctx: Context<AcceptTask>,
    task_id: u64,
) -> Result<()>
// Agent posts their bond here — transfered into BondVault PDA

pub fn submit_result(
    ctx: Context<SubmitResult>,
    task_id: u64,
    result_hash: [u8; 32],
) -> Result<()>
// Agent marks task submitted + stores IPFS hash of their output

pub fn verify_result(
    ctx: Context<VerifyResult>,
    task_id: u64,
    quality_score: u8,
    passed: bool,
) -> Result<()>
// Called by judge oracle keypair only
// If passed: release bond + reward → agent, update profile, mint cNFT
// If failed: slash bond → treasury (50%) + operator (50%), update profile

pub fn claim_expired(
    ctx: Context<ClaimExpired>,
    task_id: u64,
) -> Result<()>
// Operator reclaims reward if agent missed deadline
```

**PDA seeds** (keep these consistent everywhere):

```rust
// Bond vault PDA
seeds = [b"bond_vault", task.key().as_ref()]

// Task PDA
seeds = [b"task", operator.key().as_ref(), task_id.to_le_bytes().as_ref()]

// Agent profile PDA
seeds = [b"agent_profile", agent.key().as_ref()]
```

Now your 7-day sprint — tap each day to see exactly what to build:Tap each day to expand the full task list, and click the green dot to track your progress. Hit "Get help with this day" and I'll go deep on that specific piece.

**Three things that will separate you from the other 1,500+ submissions:**

The first is the judge oracle being Claude. Using the Anthropic API to score output quality is a genuinely novel primitive — it's not just "AI agent + blockchain," it's using AI to *verify* AI agents, which is the actual unsolved problem. Mention this explicitly in your submission.

The second is the x402 integration. Even a stub that shows an agent autonomously paying for a task via the x402 protocol puts you squarely in the hottest thesis Solana is currently funding. Check the Colosseum sponsor docs for Altitude — they're a primary sponsor and directly related to agent payments.

The third is your existing codebase. You can demo a working system on Day 5 while most teams are still debugging their Anchor programs. Use that time buffer to polish the demo and write a sharp README — that's what converts a $10k prize into a $250k accelerator seat.

What do you want to go deeper on first — the Anchor program, the judge oracle API, or the x402 integration?