import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Agentbond } from "../target/types/stakepact";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

describe("stakepact", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Agentbond as Program<Agentbond>;

  const operator = provider.wallet as anchor.Wallet;
  const agent = Keypair.generate();
  const oracle = Keypair.generate();
  const treasury = Keypair.generate();

  const taskId = new BN(1);
  const bondAmount = new BN(0.1 * LAMPORTS_PER_SOL);
  const rewardAmount = new BN(0.2 * LAMPORTS_PER_SOL);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("program_config")],
    program.programId
  );

  let taskPda: PublicKey;
  let bondVaultPda: PublicKey;
  let agentProfilePda: PublicKey;

  before(async () => {
    // Fund agent
    const sig = await provider.connection.requestAirdrop(agent.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), operator.publicKey.toBuffer(), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [bondVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bond_vault"), taskPda.toBuffer()],
      program.programId
    );
    [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_profile"), agent.publicKey.toBuffer()],
      program.programId
    );
  });

  it("initialize_config", async () => {
    await program.methods
      .initializeConfig(oracle.publicKey, treasury.publicKey)
      .accounts({ config: configPda, authority: operator.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const config = await program.account.programConfig.fetch(configPda);
    assert.ok(config.oracle.equals(oracle.publicKey));
    assert.ok(config.treasury.equals(treasury.publicKey));
  });

  it("create_task", async () => {
    const descHash = Array(32).fill(1);
    await program.methods
      .createTask(taskId, bondAmount, rewardAmount, descHash, deadline)
      .accounts({
        task: taskPda,
        bondVault: bondVaultPda,
        operator: operator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const task = await program.account.task.fetch(taskPda);
    assert.ok(task.operator.equals(operator.publicKey));
    assert.equal(task.bondAmount.toString(), bondAmount.toString());
    assert.equal(task.rewardAmount.toString(), rewardAmount.toString());
    assert.deepEqual(task.status, { open: {} });

    const vaultBalance = await provider.connection.getBalance(bondVaultPda);
    assert.isAtLeast(vaultBalance, rewardAmount.toNumber());
  });

  it("accept_task", async () => {
    const vaultBefore = await provider.connection.getBalance(bondVaultPda);

    await program.methods
      .acceptTask(taskId)
      .accounts({
        task: taskPda,
        bondVault: bondVaultPda,
        agentProfile: agentProfilePda,
        agent: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    const task = await program.account.task.fetch(taskPda);
    assert.ok(task.agent.equals(agent.publicKey));
    assert.deepEqual(task.status, { accepted: {} });

    const vaultAfter = await provider.connection.getBalance(bondVaultPda);
    assert.equal(vaultAfter - vaultBefore, bondAmount.toNumber());

    const profile = await program.account.agentProfile.fetch(agentProfilePda);
    assert.equal(profile.totalTasks, 1);
  });

  it("submit_result", async () => {
    const resultHash = Array(32).fill(2);
    await program.methods
      .submitResult(taskId, resultHash)
      .accounts({ task: taskPda, agent: agent.publicKey })
      .signers([agent])
      .rpc();

    const task = await program.account.task.fetch(taskPda);
    assert.deepEqual(task.status, { submitted: {} });
    assert.deepEqual(task.resultHash, resultHash);
  });

  it("verify_result (pass)", async () => {
    const agentBalBefore = await provider.connection.getBalance(agent.publicKey);

    await program.methods
      .verifyResult(taskId, 90, true)
      .accounts({
        config: configPda,
        task: taskPda,
        bondVault: bondVaultPda,
        agentProfile: agentProfilePda,
        agent: agent.publicKey,
        operator: operator.publicKey,
        treasury: treasury.publicKey,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    const task = await program.account.task.fetch(taskPda);
    assert.deepEqual(task.status, { verified: {} });
    assert.equal(task.qualityScore, 90);

    const agentBalAfter = await provider.connection.getBalance(agent.publicKey);
    assert.isAbove(agentBalAfter, agentBalBefore);

    const profile = await program.account.agentProfile.fetch(agentProfilePda);
    assert.equal(profile.completedTasks, 1);
    assert.equal(profile.reliabilityScore, 100);
  });

  it("rejects non-oracle signer on verify_result", async () => {
    // Create a second task to test rejection
    const taskId2 = new BN(2);
    const [taskPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), operator.publicKey.toBuffer(), taskId2.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("bond_vault"), taskPda2.toBuffer()],
      program.programId
    );
    const [profilePda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_profile"), agent.publicKey.toBuffer()],
      program.programId
    );

    const descHash = Array(32).fill(3);
    await program.methods
      .createTask(taskId2, bondAmount, rewardAmount, descHash, deadline)
      .accounts({ task: taskPda2, bondVault: vaultPda2, operator: operator.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .acceptTask(taskId2)
      .accounts({ task: taskPda2, bondVault: vaultPda2, agentProfile: profilePda2, agent: agent.publicKey, systemProgram: SystemProgram.programId })
      .signers([agent])
      .rpc();

    await program.methods
      .submitResult(taskId2, Array(32).fill(4))
      .accounts({ task: taskPda2, agent: agent.publicKey })
      .signers([agent])
      .rpc();

    const fakeOracle = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fakeOracle.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .verifyResult(taskId2, 50, false)
        .accounts({
          config: configPda,
          task: taskPda2,
          bondVault: vaultPda2,
          agentProfile: profilePda2,
          agent: agent.publicKey,
          operator: operator.publicKey,
          treasury: treasury.publicKey,
          oracle: fakeOracle.publicKey,
        })
        .signers([fakeOracle])
        .rpc();
      assert.fail("Should have thrown");
    } catch (e: any) {
      assert.include(e.toString(), "Error");
    }
  });
});
