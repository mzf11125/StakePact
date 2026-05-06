/**
 * x402 Agent Client — powered by PayAI facilitator
 *
 * Autonomously pays the x402 server to retrieve a task brief,
 * then calls accept_task on-chain.
 *
 * Usage: ts-node client.ts <taskId> [operatorPubkey]
 *
 * Env vars:
 *   SVM_PRIVATE_KEY     - Base58 Solana private key of the paying agent
 *   RPC_URL             - Solana RPC (default: devnet)
 *   PROGRAM_ID          - AgenTrade program ID
 *   X402_SERVER_URL     - x402 server base URL (default: http://localhost:3402)
 */

import { config } from "dotenv";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import * as fs from "fs";
import * as path from "path";

config({ path: path.join(__dirname, "../.env") });

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13"
);
const X402_URL = process.env.X402_SERVER_URL ?? "http://localhost:3402";
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;

if (!SVM_PRIVATE_KEY) {
  console.error("Missing required env var: SVM_PRIVATE_KEY (Base58 Solana private key)");
  process.exit(1);
}

async function main() {
  const taskIdStr = process.argv[2];
  if (!taskIdStr) {
    console.error("Usage: ts-node client.ts <taskId> [operatorPubkey]");
    process.exit(1);
  }

  // Build x402 fetch client with SVM scheme
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(SVM_PRIVATE_KEY!));
  const client = new x402Client();
  registerExactSvmScheme(client, { signer: svmSigner });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`Fetching task brief for task ${taskIdStr} via x402...`);
  const res = await fetchWithPayment(`${X402_URL}/task-brief/${taskIdStr}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`x402 request failed: ${JSON.stringify(err)}`);
  }

  const { data } = (await res.json()) as { data: object };
  console.log("✅ Task brief received:", data);

  // Optionally call accept_task on-chain
  const operatorStr = process.argv[3];
  if (!operatorStr) {
    console.log("Tip: pass operator pubkey as 3rd arg to also call accept_task on-chain.");
    return;
  }

  const agentKeypair = Keypair.fromSecretKey(base58.decode(SVM_PRIVATE_KEY!));
  const connection = new Connection(RPC_URL, "confirmed");
  const taskId = new anchor.BN(taskIdStr);
  const operator = new PublicKey(operatorStr);
  const taskIdBuf = taskId.toArrayLike(Buffer, "le", 8);

  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), operator.toBuffer(), taskIdBuf],
    PROGRAM_ID
  );
  const [bondVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault"), taskPda.toBuffer()],
    PROGRAM_ID
  );
  const [agentProfilePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_profile"), agentKeypair.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const idlPath = path.join(__dirname, "../agentrade/target/idl/agentrade.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const wallet = new anchor.Wallet(agentKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const program = new anchor.Program(idl, provider);

  console.log("Calling accept_task on-chain...");
  const tx = await (program.methods as any)
    .acceptTask(taskId)
    .accounts({
      task: taskPda,
      bondVault: bondVaultPda,
      agentProfile: agentProfilePda,
      agent: agentKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([agentKeypair])
    .rpc();

  console.log(`✅ accept_task submitted: ${tx}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
