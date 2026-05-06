#!/usr/bin/env ts-node
/**
 * AgenTrade Judge Oracle
 * Usage: ts-node oracle.ts <task_pubkey>
 *
 * Env vars required:
 *   ORACLE_KEYPAIR_PATH  - path to oracle keypair JSON (default: ~/.config/solana/id.json)
 *   ANTHROPIC_API_KEY    - Claude API key
 *   RPC_URL              - Solana RPC (default: devnet)
 *   PROGRAM_ID           - AgenTrade program ID
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13"
);
const ORACLE_KEYPAIR_PATH =
  process.env.ORACLE_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function scoreWithClaude(
  description: string,
  result: string
): Promise<{ score: number; passed: boolean; reasoning: string }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `You are a task quality judge. Score the following agent output.

TASK DESCRIPTION: ${description}

AGENT OUTPUT: ${result}

Respond with ONLY valid JSON in this exact format:
{"score": <0-100>, "passed": <true if score >= 70>, "reasoning": "<one sentence>"}`,
      },
    ],
  });

  const text = (message.content[0] as { type: string; text: string }).text;
  return JSON.parse(text);
}

async function main() {
  const taskPubkeyStr = process.argv[2];
  if (!taskPubkeyStr) {
    console.error("Usage: ts-node oracle.ts <task_pubkey>");
    process.exit(1);
  }

  const taskPubkey = new PublicKey(taskPubkeyStr);
  const oracleKeypair = loadKeypair(ORACLE_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");

  // Load IDL
  const idlPath = path.join(__dirname, "../agentrade/target/idl/agentrade.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(oracleKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const program = new anchor.Program(idl, provider);

  // Fetch task account
  const task = await (program.account as any).task.fetch(taskPubkey);
  console.log(`Task status: ${JSON.stringify(task.status)}`);
  console.log(`Task agent: ${task.agent.toBase58()}`);

  if (!task.status.submitted) {
    console.error("Task is not in Submitted status. Aborting.");
    process.exit(1);
  }

  // Resolve description and result from hashes
  // In production these would be IPFS CID lookups.
  // For demo, we use the hash bytes as hex strings.
  const descriptionHex = Buffer.from(task.descriptionHash).toString("hex");
  const resultHex = Buffer.from(task.resultHash).toString("hex");

  console.log(`Description hash: ${descriptionHex}`);
  console.log(`Result hash: ${resultHex}`);
  console.log("Calling Claude to score result...");

  const { score, passed, reasoning } = await scoreWithClaude(
    `Task with description hash: ${descriptionHex}`,
    `Agent submitted result with hash: ${resultHex}`
  );

  console.log(`Score: ${score}/100 | Passed: ${passed}`);
  console.log(`Reasoning: ${reasoning}`);

  // Derive PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("program_config")],
    PROGRAM_ID
  );
  const config = await (program.account as any).programConfig.fetch(configPda);

  const [bondVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault"), taskPubkey.toBuffer()],
    PROGRAM_ID
  );
  const [agentProfilePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_profile"), task.agent.toBuffer()],
    PROGRAM_ID
  );

  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(task.taskId.toString()));
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), task.operator.toBuffer(), taskIdBuf],
    PROGRAM_ID
  );

  console.log("Submitting verify_result on-chain...");

  const tx = await (program.methods as any)
    .verifyResult(task.taskId, score, passed)
    .accounts({
      config: configPda,
      task: taskPda,
      bondVault: bondVaultPda,
      agentProfile: agentProfilePda,
      agent: task.agent,
      operator: task.operator,
      treasury: config.treasury,
      oracle: oracleKeypair.publicKey,
    })
    .signers([oracleKeypair])
    .rpc();

  console.log(`✅ verify_result submitted: ${tx}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
