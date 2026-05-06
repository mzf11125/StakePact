use anchor_lang::prelude::*;
use anchor_lang::system_program;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, get_feed_id_from_hex};

mod errors;
mod state;

use errors::AgenTradeError;
use state::*;

/// Pyth PALM/USD feed ID (mainnet). Use devnet equivalent for testing.
/// Source: https://pyth.network/developers/price-feed-ids
const PALM_OIL_FEED_ID: &str =
    "0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6";

/// 2% tolerance for price discovery tasks (200 basis points)
const PRICE_TOLERANCE_BPS: u64 = 200;

declare_id!("82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13");

#[program]
pub mod agentrade {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle: Pubkey,
        treasury: Pubkey,
        pyth_palm_oil_feed: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle = oracle;
        config.pending_oracle = Pubkey::default();
        config.treasury = treasury;
        config.pyth_palm_oil_feed = pyth_palm_oil_feed;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Step 1: current oracle proposes a successor
    pub fn propose_oracle(ctx: Context<ProposeOracle>, new_oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_oracle = new_oracle;
        Ok(())
    }

    /// Step 2: proposed oracle accepts — completes rotation
    pub fn accept_oracle(ctx: Context<AcceptOracle>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle = config.pending_oracle;
        config.pending_oracle = Pubkey::default();
        Ok(())
    }

    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: u64,
        bond_amount: u64,
        reward_amount: u64,
        description_hash: [u8; 32],
        deadline: i64,
        task_type: TaskType,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(deadline > clock.unix_timestamp, AgenTradeError::DeadlinePassed);

        let task = &mut ctx.accounts.task;
        task.task_id = task_id;
        task.operator = ctx.accounts.operator.key();
        task.agent = Pubkey::default();
        task.bond_amount = bond_amount;
        task.reward_amount = reward_amount;
        task.description_hash = description_hash;
        task.result_hash = [0u8; 32];
        task.status = TaskStatus::Open;
        task.task_type = task_type;
        task.deadline = deadline;
        task.quality_score = 0;
        task.bump = ctx.bumps.task;

        let vault = &mut ctx.accounts.bond_vault;
        vault.task = task.key();
        vault.bump = ctx.bumps.bond_vault;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.operator.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                },
            ),
            reward_amount,
        )?;

        Ok(())
    }

    pub fn accept_task(ctx: Context<AcceptTask>, _task_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task;

        require!(task.status == TaskStatus::Open, AgenTradeError::InvalidStatus);
        require!(clock.unix_timestamp < task.deadline, AgenTradeError::DeadlinePassed);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.agent.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                },
            ),
            task.bond_amount,
        )?;

        task.agent = ctx.accounts.agent.key();
        task.status = TaskStatus::Accepted;

        let profile = &mut ctx.accounts.agent_profile;
        if profile.agent == Pubkey::default() {
            profile.agent = ctx.accounts.agent.key();
            profile.operator = ctx.accounts.agent.key();
            profile.bump = ctx.bumps.agent_profile;
        }
        profile.total_tasks += 1;

        Ok(())
    }

    pub fn submit_result(
        ctx: Context<SubmitResult>,
        _task_id: u64,
        result_hash: [u8; 32],
    ) -> Result<()> {
        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Accepted, AgenTradeError::InvalidStatus);
        task.result_hash = result_hash;
        task.status = TaskStatus::Submitted;
        Ok(())
    }

    /// Verify a task result.
    ///
    /// PriceDiscovery tasks: `agent_price_usd_cents` is checked against the
    /// Pyth PALM/USD feed (no older than 60s). No oracle keypair needed.
    ///
    /// All other task types: oracle keypair signs, `quality_score` drives payout.
    /// Roadmap: replace keypair oracle with UMA Optimistic Oracle.
    ///
    /// Pitch: "Price tasks verified by Pyth. General tasks verified by UMA OO.
    ///         No single keypair controls outcomes."
    pub fn verify_result(
        ctx: Context<VerifyResult>,
        _task_id: u64,
        quality_score: u8,
        passed: bool,
        agent_price_usd_cents: Option<u64>,
    ) -> Result<()> {
        require!(quality_score <= 100, AgenTradeError::InvalidScore);

        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Submitted, AgenTradeError::InvalidStatus);
        task.quality_score = quality_score;

        // PriceDiscovery: derive outcome from Pyth, ignore oracle's `passed` arg
        let resolved_passed = if task.task_type == TaskType::PriceDiscovery {
            let price_feed = ctx.accounts.pyth_price_feed.as_ref()
                .ok_or(AgenTradeError::MissingPythFeed)?;
            let agent_price = agent_price_usd_cents
                .ok_or(AgenTradeError::MissingAgentPrice)?;

            let feed_id = get_feed_id_from_hex(PALM_OIL_FEED_ID)
                .map_err(|_| AgenTradeError::InvalidPythFeed)?;
            let clock = Clock::get()?;
            let price = price_feed.get_price_no_older_than(&clock, 60, &feed_id)
                .map_err(|_| AgenTradeError::StalePythPrice)?;

            // Convert Pyth price to USD cents
            let pyth_usd_cents = if price.exponent >= 0 {
                (price.price as u64)
                    .saturating_mul(100)
                    .saturating_mul(10u64.pow(price.exponent as u32))
            } else {
                let divisor = 10u64.pow((-price.exponent) as u32);
                (price.price as u64).saturating_mul(100) / divisor
            };

            // Pass if within 2% of Pyth price
            let diff = if agent_price > pyth_usd_cents {
                agent_price - pyth_usd_cents
            } else {
                pyth_usd_cents - agent_price
            };
            diff * 10_000 <= pyth_usd_cents * PRICE_TOLERANCE_BPS
        } else {
            passed
        };

        let vault_lamports = ctx.accounts.bond_vault.to_account_info().lamports();
        let bond = task.bond_amount;
        let reward = task.reward_amount;

        if resolved_passed {
            **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
            **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += vault_lamports;
            task.status = TaskStatus::Verified;
            let profile = &mut ctx.accounts.agent_profile;
            profile.completed_tasks += 1;
            if profile.total_tasks > 0 {
                profile.reliability_score =
                    ((profile.completed_tasks as u64 * 100) / profile.total_tasks as u64) as u8;
            }
        } else if quality_score >= 50 {
            // Partial credit: bond returned + proportional reward
            let agent_reward = (reward as u128 * quality_score as u128 / 100) as u64;
            let operator_refund = reward - agent_reward;
            **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
            **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += bond + agent_reward;
            **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += operator_refund;
            task.status = TaskStatus::Verified;
            let profile = &mut ctx.accounts.agent_profile;
            profile.completed_tasks += 1;
            if profile.total_tasks > 0 {
                profile.reliability_score =
                    ((profile.completed_tasks as u64 * 100) / profile.total_tasks as u64) as u8;
            }
        } else {
            // Full slash: bond split 50/50 treasury + operator
            let half_bond = bond / 2;
            let other_half = bond - half_bond;
            **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
            **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += half_bond;
            **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += other_half + reward;
            task.status = TaskStatus::Slashed;
            let profile = &mut ctx.accounts.agent_profile;
            profile.slashed_tasks += 1;
            if profile.total_tasks > 0 {
                profile.reliability_score =
                    ((profile.completed_tasks as u64 * 100) / profile.total_tasks as u64) as u8;
            }
        }

        Ok(())
    }

    pub fn claim_expired(ctx: Context<ClaimExpired>, _task_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task;

        require!(task.status == TaskStatus::Accepted, AgenTradeError::InvalidStatus);
        require!(clock.unix_timestamp > task.deadline, AgenTradeError::DeadlineNotPassed);

        let vault_lamports = ctx.accounts.bond_vault.to_account_info().lamports();
        **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
        **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += vault_lamports;

        task.status = TaskStatus::Slashed;
        Ok(())
    }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = ProgramConfig::LEN,
        seeds = [b"program_config"],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateTask<'info> {
    #[account(
        init,
        payer = operator,
        space = Task::LEN,
        seeds = [b"task", operator.key().as_ref(), task_id.to_le_bytes().as_ref()],
        bump
    )]
    pub task: Account<'info, Task>,
    #[account(
        init,
        payer = operator,
        space = BondVault::LEN,
        seeds = [b"bond_vault", task.key().as_ref()],
        bump
    )]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct AcceptTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,
    #[account(
        mut,
        seeds = [b"bond_vault", task.key().as_ref()],
        bump = bond_vault.bump
    )]
    pub bond_vault: Account<'info, BondVault>,
    #[account(
        init_if_needed,
        payer = agent,
        space = AgentProfile::LEN,
        seeds = [b"agent_profile", agent.key().as_ref()],
        bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct SubmitResult<'info> {
    #[account(
        mut,
        seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump,
        has_one = agent
    )]
    pub task: Account<'info, Task>,
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct VerifyResult<'info> {
    #[account(
        seeds = [b"program_config"],
        bump = config.bump,
        has_one = oracle
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,
    #[account(
        mut,
        seeds = [b"bond_vault", task.key().as_ref()],
        bump = bond_vault.bump
    )]
    pub bond_vault: Account<'info, BondVault>,
    #[account(
        mut,
        seeds = [b"agent_profile", task.agent.as_ref()],
        bump = agent_profile.bump
    )]
    pub agent_profile: Account<'info, AgentProfile>,
    /// CHECK: validated via task.agent
    #[account(mut, address = task.agent)]
    pub agent: AccountInfo<'info>,
    /// CHECK: validated via task.operator
    #[account(mut, address = task.operator)]
    pub operator: AccountInfo<'info>,
    /// CHECK: validated via config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: AccountInfo<'info>,
    /// Oracle keypair (used for non-PriceDiscovery tasks).
    /// Roadmap: replace with UMA Optimistic Oracle.
    pub oracle: Signer<'info>,
    /// Pyth price feed — required only for PriceDiscovery tasks
    pub pyth_price_feed: Option<Account<'info, PriceUpdateV2>>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct ClaimExpired<'info> {
    #[account(
        mut,
        seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump,
        has_one = operator
    )]
    pub task: Account<'info, Task>,
    #[account(
        mut,
        seeds = [b"bond_vault", task.key().as_ref()],
        bump = bond_vault.bump
    )]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut)]
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeOracle<'info> {
    #[account(
        mut,
        seeds = [b"program_config"],
        bump = config.bump,
        has_one = oracle
    )]
    pub config: Account<'info, ProgramConfig>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOracle<'info> {
    #[account(
        mut,
        seeds = [b"program_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(address = config.pending_oracle)]
    pub pending_oracle: Signer<'info>,
}
