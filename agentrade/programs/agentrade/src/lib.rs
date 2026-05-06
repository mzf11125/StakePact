use anchor_lang::prelude::*;
use anchor_lang::system_program;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, get_feed_id_from_hex};

mod errors;
mod state;

use errors::AgenTradeError;
use state::*;

const PALM_OIL_FEED_ID: &str =
    "0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6";
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

    pub fn propose_oracle(ctx: Context<ProposeOracle>, new_oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_oracle = new_oracle;
        Ok(())
    }

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
        task.submitted_at = 0;
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
        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Accepted, AgenTradeError::InvalidStatus);
        task.result_hash = result_hash;
        task.status = TaskStatus::Submitted;
        task.submitted_at = clock.unix_timestamp;
        Ok(())
    }

    /// PriceDiscovery: verified immediately against Pyth (no challenge window needed).
    ///
    /// All other task types use the optimistic oracle (UMA-inspired):
    ///   - After submit, anyone has CHALLENGE_WINDOW (2h) to call dispute_result.
    ///   - If no dispute: call settle_result after the window to auto-release funds.
    ///   - If disputed: oracle arbitrates via arbitrate_dispute.
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
        // Only PriceDiscovery uses this instruction directly — others go through settle/arbitrate
        require!(task.task_type == TaskType::PriceDiscovery, AgenTradeError::InvalidStatus);

        task.quality_score = quality_score;

        let pyth_ai = ctx.accounts.pyth_price_feed.as_ref()
            .ok_or(AgenTradeError::MissingPythFeed)?;
        let agent_price = agent_price_usd_cents
            .ok_or(AgenTradeError::MissingAgentPrice)?;
        let feed_id = get_feed_id_from_hex(PALM_OIL_FEED_ID)
            .map_err(|_| AgenTradeError::InvalidPythFeed)?;
        let clock = Clock::get()?;
        let data = pyth_ai.try_borrow_data()?;
        let price_feed = PriceUpdateV2::try_from_slice(&data[8..])
            .map_err(|_| AgenTradeError::InvalidPythFeed)?;
        let price = price_feed.get_price_no_older_than(&clock, 60, &feed_id)
            .map_err(|_| AgenTradeError::StalePythPrice)?;

        let pyth_usd_cents = if price.exponent >= 0 {
            (price.price as u64)
                .saturating_mul(100)
                .saturating_mul(10u64.pow(price.exponent as u32))
        } else {
            let divisor = 10u64.pow((-price.exponent) as u32);
            (price.price as u64).saturating_mul(100) / divisor
        };

        let diff = if agent_price > pyth_usd_cents {
            agent_price - pyth_usd_cents
        } else {
            pyth_usd_cents - agent_price
        };
        let resolved_passed = diff * 10_000 <= pyth_usd_cents * PRICE_TOLERANCE_BPS;

        payout(ctx.accounts.bond_vault.to_account_info(),
               ctx.accounts.agent.to_account_info(),
               ctx.accounts.operator.to_account_info(),
               ctx.accounts.treasury.to_account_info(),
               task, resolved_passed, quality_score)?;

        let profile = &mut ctx.accounts.agent_profile;
        update_profile(profile, resolved_passed || quality_score >= 50);
        Ok(())
    }

    /// Optimistic oracle — anyone can dispute a submitted result within CHALLENGE_WINDOW.
    /// Disputer posts a bond equal to the agent's bond.
    pub fn dispute_result(ctx: Context<DisputeResult>, _task_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Submitted, AgenTradeError::InvalidStatus);
        require!(
            clock.unix_timestamp <= task.submitted_at + CHALLENGE_WINDOW,
            AgenTradeError::ChallengeWindowExpired
        );

        let dispute_bond = task.bond_amount;

        // Disputer posts bond into vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.disputer.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                },
            ),
            dispute_bond,
        )?;

        let dispute = &mut ctx.accounts.dispute;
        dispute.task = task.key();
        dispute.disputer = ctx.accounts.disputer.key();
        dispute.bond_amount = dispute_bond;
        dispute.bump = ctx.bumps.dispute;

        task.status = TaskStatus::Disputed;
        Ok(())
    }

    /// Optimistic oracle — if no dispute after CHALLENGE_WINDOW, anyone can settle.
    /// Agent gets bond + reward automatically. No oracle keypair needed.
    pub fn settle_result(ctx: Context<SettleResult>, _task_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Submitted, AgenTradeError::InvalidStatus);
        require!(
            clock.unix_timestamp > task.submitted_at + CHALLENGE_WINDOW,
            AgenTradeError::ChallengeWindowOpen
        );

        let vault_lamports = ctx.accounts.bond_vault.to_account_info().lamports();
        **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
        **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += vault_lamports;

        task.status = TaskStatus::Verified;
        task.quality_score = 100;

        let profile = &mut ctx.accounts.agent_profile;
        update_profile(profile, true);
        Ok(())
    }

    /// Oracle arbitrates a disputed result.
    /// agent_wins=true  → agent gets bond+reward, disputer's bond slashed to treasury.
    /// agent_wins=false → disputer gets their bond back + agent's bond, reward back to operator.
    pub fn arbitrate_dispute(
        ctx: Context<ArbitrateDispute>,
        _task_id: u64,
        agent_wins: bool,
        quality_score: u8,
    ) -> Result<()> {
        require!(quality_score <= 100, AgenTradeError::InvalidScore);
        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Disputed, AgenTradeError::InvalidStatus);
        task.quality_score = quality_score;

        let vault_lamports = ctx.accounts.bond_vault.to_account_info().lamports();
        let agent_bond = task.bond_amount;
        let dispute_bond = ctx.accounts.dispute.bond_amount;
        let reward = task.reward_amount;

        if agent_wins {
            // Agent wins: gets bond + reward. Disputer's bond → treasury.
            let agent_payout = vault_lamports - dispute_bond;
            **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
            **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += agent_payout;
            **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += dispute_bond;
            task.status = TaskStatus::Verified;
            let profile = &mut ctx.accounts.agent_profile;
            update_profile(profile, true);
        } else {
            // Disputer wins: gets their bond back + agent's bond. Reward → operator.
            let disputer_payout = dispute_bond + agent_bond;
            **ctx.accounts.bond_vault.to_account_info().try_borrow_mut_lamports()? -= vault_lamports;
            **ctx.accounts.disputer.to_account_info().try_borrow_mut_lamports()? += disputer_payout;
            **ctx.accounts.operator.to_account_info().try_borrow_mut_lamports()? += reward;
            task.status = TaskStatus::Slashed;
            let profile = &mut ctx.accounts.agent_profile;
            update_profile(profile, false);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

fn payout<'info>(
    vault: AccountInfo<'info>,
    agent: AccountInfo<'info>,
    operator: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    task: &mut Account<Task>,
    passed: bool,
    quality_score: u8,
) -> Result<()> {
    let vault_lamports = vault.lamports();
    let bond = task.bond_amount;
    let reward = task.reward_amount;

    if passed {
        **vault.try_borrow_mut_lamports()? -= vault_lamports;
        **agent.try_borrow_mut_lamports()? += vault_lamports;
        task.status = TaskStatus::Verified;
    } else if quality_score >= 50 {
        let agent_reward = (reward as u128 * quality_score as u128 / 100) as u64;
        let operator_refund = reward - agent_reward;
        **vault.try_borrow_mut_lamports()? -= vault_lamports;
        **agent.try_borrow_mut_lamports()? += bond + agent_reward;
        **operator.try_borrow_mut_lamports()? += operator_refund;
        task.status = TaskStatus::Verified;
    } else {
        let half = bond / 2;
        **vault.try_borrow_mut_lamports()? -= vault_lamports;
        **treasury.try_borrow_mut_lamports()? += half;
        **operator.try_borrow_mut_lamports()? += (bond - half) + reward;
        task.status = TaskStatus::Slashed;
    }
    Ok(())
}

fn update_profile(profile: &mut Account<AgentProfile>, success: bool) {
    if success {
        profile.completed_tasks += 1;
    } else {
        profile.slashed_tasks += 1;
    }
    if profile.total_tasks > 0 {
        profile.reliability_score =
            ((profile.completed_tasks as u64 * 100) / profile.total_tasks as u64) as u8;
    }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = authority, space = ProgramConfig::LEN, seeds = [b"program_config"], bump)]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct CreateTask<'info> {
    #[account(init, payer = operator, space = Task::LEN,
        seeds = [b"task", operator.key().as_ref(), task_id.to_le_bytes().as_ref()], bump)]
    pub task: Account<'info, Task>,
    #[account(init, payer = operator, space = BondVault::LEN,
        seeds = [b"bond_vault", task.key().as_ref()], bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct AcceptTask<'info> {
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()], bump = task.bump)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(init_if_needed, payer = agent, space = AgentProfile::LEN,
        seeds = [b"agent_profile", agent.key().as_ref()], bump)]
    pub agent_profile: Account<'info, AgentProfile>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct SubmitResult<'info> {
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump, has_one = agent)]
    pub task: Account<'info, Task>,
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct VerifyResult<'info> {
    #[account(seeds = [b"program_config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()], bump = task.bump)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut, seeds = [b"agent_profile", task.agent.as_ref()], bump = agent_profile.bump)]
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
    pub oracle: Signer<'info>,
    /// CHECK: Pyth price feed account — deserialized manually inside verify_result
    pub pyth_price_feed: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct DisputeResult<'info> {
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()], bump = task.bump)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(init, payer = disputer, space = Dispute::LEN,
        seeds = [b"dispute", task.key().as_ref()], bump)]
    pub dispute: Account<'info, Dispute>,
    #[account(mut)]
    pub disputer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct SettleResult<'info> {
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()], bump = task.bump)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut, seeds = [b"agent_profile", task.agent.as_ref()], bump = agent_profile.bump)]
    pub agent_profile: Account<'info, AgentProfile>,
    /// CHECK: validated via task.agent
    #[account(mut, address = task.agent)]
    pub agent: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct ArbitrateDispute<'info> {
    #[account(seeds = [b"program_config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()], bump = task.bump)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut, seeds = [b"dispute", task.key().as_ref()], bump = dispute.bump)]
    pub dispute: Account<'info, Dispute>,
    #[account(mut, seeds = [b"agent_profile", task.agent.as_ref()], bump = agent_profile.bump)]
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
    /// CHECK: validated via dispute.disputer
    #[account(mut, address = dispute.disputer)]
    pub disputer: AccountInfo<'info>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct ClaimExpired<'info> {
    #[account(mut, seeds = [b"task", task.operator.as_ref(), task_id.to_le_bytes().as_ref()],
        bump = task.bump, has_one = operator)]
    pub task: Account<'info, Task>,
    #[account(mut, seeds = [b"bond_vault", task.key().as_ref()], bump = bond_vault.bump)]
    pub bond_vault: Account<'info, BondVault>,
    #[account(mut)]
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeOracle<'info> {
    #[account(mut, seeds = [b"program_config"], bump = config.bump, has_one = oracle)]
    pub config: Account<'info, ProgramConfig>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOracle<'info> {
    #[account(mut, seeds = [b"program_config"], bump = config.bump)]
    pub config: Account<'info, ProgramConfig>,
    #[account(address = config.pending_oracle)]
    pub pending_oracle: Signer<'info>,
}
