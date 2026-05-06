use anchor_lang::prelude::*;
use anchor_lang::system_program;

mod errors;
mod state;

use errors::AgenTradeError;
use state::*;

declare_id!("82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13");

#[program]
pub mod agentrade {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        oracle: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle = oracle;
        config.pending_oracle = Pubkey::default();
        config.treasury = treasury;
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
        task.deadline = deadline;
        task.quality_score = 0;
        task.bump = ctx.bumps.task;

        let vault = &mut ctx.accounts.bond_vault;
        vault.task = task.key();
        vault.bump = ctx.bumps.bond_vault;

        // Transfer reward into vault
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

        // Transfer bond from agent into vault
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

    pub fn verify_result(
        ctx: Context<VerifyResult>,
        _task_id: u64,
        quality_score: u8,
        passed: bool,
    ) -> Result<()> {
        require!(quality_score <= 100, AgenTradeError::InvalidScore);

        let task = &mut ctx.accounts.task;
        require!(task.status == TaskStatus::Submitted, AgenTradeError::InvalidStatus);

        task.quality_score = quality_score;

        let vault_lamports = ctx.accounts.bond_vault.to_account_info().lamports();
        let bond = task.bond_amount;
        let reward = task.reward_amount;

        if passed {
            // Full pass: agent gets bond + reward
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
            // Partial credit (50-99): agent gets bond back + proportional reward, operator gets remainder
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
            // Full slash (<50): bond split 50/50 treasury + operator; reward back to operator
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
    pub oracle: Signer<'info>,
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
    // pending_oracle must sign to accept
    #[account(address = config.pending_oracle)]
    pub pending_oracle: Signer<'info>,
}
