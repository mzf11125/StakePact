/**
 * x402 Agent Client
 * Autonomously pays the x402 stub server to retrieve a task brief,
 * then calls accept_task on-chain.
 *
 * Usage: ts-node client.ts <taskId>
 *
 * Env vars:
 *   AGENT_KEYPAIR_PATH  - path to agent keypair JSON
 *   RPC_URL             - Solana RPC (default: devnet)
 *   PROGRAM_ID          - AgentBond program ID
 *   X402_SERVER_URL     - x402 server base URL (default: http://localhost:3402)
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13"
);
const X402_URL = process.env.X402_SERVER_URL ?? "http://localhost:3402";
const AGENT_KEYPAIR_PATH =
  process.env.AGENT_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function x402Pay(
  connection: Connection,
  payer: Keypair,
  taskId: string
): Promise<object> {
  // Step 1: Request task brief — expect 402
  const quoteRes = await fetch(`${X402_URL}/task-brief/${taskId}`);
  if (quoteRes.status !== 402) throw new Error(`Expected 402, got ${quoteRes.status}`);

  const quote = (await quoteRes.json()) as {
    accepts: Array<{ payTo: string; maxAmountRequired: string }>;
  };

  const paymentReq = quote.accepts[0];
  const recipient = new PublicKey(paymentReq.payTo);
  const amount = parseInt(paymentReq.maxAmountRequired);

  console.log(`x402: Payment required — ${amount} lamports to ${recipient.toBase58()}`);

  // Step 2: Build and sign a SOL transfer (don't submit yet — server will)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: amount,
    })
  );
  tx.sign(payer);

  const serializedTx = tx.serialize().toString("base64");

  const paymentProof = {
    x402Version: 1,
    scheme: "exact",
    network: "solana-devnet",
    payload: { serializedTransaction: serializedTx },
  };
  const xPaymentHeader = Buffer.from(JSON.stringify(paymentProof)).toString("base64");

  // Step 3: Retry with X-Payment header
  console.log("x402: Sending payment proof to server...");
  const paidRes = await fetch(`${X402_URL}/task-brief/${taskId}`, {
    headers: { "X-Payment": xPaymentHeader },
  });

  if (!paidRes.ok) {
    const err = await paidRes.json();
    throw new Error(`x402 payment failed: ${JSON.stringify(err)}`);
  }

  const { data } = (await paidRes.json()) as { data: object };
  console.log("✅ x402 payment accepted. Task brief received:", data);
  return data;
}

async function main() {
  const taskIdStr = process.argv[2];
  if (!taskIdStr) {
    console.error("Usage: ts-node client.ts <taskId>");
    process.exit(1);
  }

  const taskId = new anchor.BN(taskIdStr);
  const agentKeypair = loadKeypair(AGENT_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`Agent: ${agentKeypair.publicKey.toBase58()}`);

  // Step 1: x402 payment to get task brief
  await x402Pay(connection, agentKeypair, taskIdStr);

  // Step 2: Load IDL and call accept_task on-chain
  const idlPath = path.join(__dirname, "../agentbond/target/idl/agentbond.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(agentKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const program = new anchor.Program(idl, provider);

  // We need the operator pubkey to derive the task PDA.
  // In a real app this comes from the task list. Here we read it from the task account
  // by scanning or passing it as an arg. For demo, we derive it from the brief.
  // Instead, let the user pass operator pubkey as 3rd arg.
  const operatorStr = process.argv[3];
  if (!operatorStr) {
    console.log("Tip: pass operator pubkey as 3rd arg to also call accept_task on-chain.");
    console.log("x402 flow complete. Exiting.");
    return;
  }

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
