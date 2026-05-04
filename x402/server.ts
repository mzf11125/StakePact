/**
 * x402 Stub Server
 * Protects /task-brief/:taskId behind a SOL micropayment.
 *
 * Flow:
 *   GET /task-brief/:taskId          → 402 with payment requirements
 *   GET /task-brief/:taskId + X-Payment header → verify tx on-chain → 200 with brief
 *
 * Env vars:
 *   RECIPIENT_PUBKEY  - wallet that receives the payment
 *   PAYMENT_LAMPORTS  - amount required (default: 1000000 = 0.001 SOL)
 *   RPC_URL           - Solana RPC (default: devnet)
 *   PORT              - server port (default: 3402)
 */

import express from "express";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
app.use(express.json());

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const RECIPIENT = new PublicKey(
  process.env.RECIPIENT_PUBKEY ?? "11111111111111111111111111111111"
);
const PAYMENT_LAMPORTS = parseInt(process.env.PAYMENT_LAMPORTS ?? "1000000");
const PORT = parseInt(process.env.PORT ?? "3402");

// Mock task briefs (in production these come from IPFS)
const TASK_BRIEFS: Record<string, object> = {
  "1": {
    taskId: 1,
    title: "Summarize Solana whitepaper",
    description: "Provide a 3-paragraph summary of the Solana whitepaper focusing on PoH.",
    bondAmount: 100000000,
    rewardAmount: 200000000,
  },
  "2": {
    taskId: 2,
    title: "Write a Rust hello world",
    description: "Write a minimal Rust program that prints 'Hello, AgentBond!'",
    bondAmount: 50000000,
    rewardAmount: 100000000,
  },
};

async function verifyPayment(xPaymentHeader: string): Promise<boolean> {
  try {
    const paymentData = JSON.parse(
      Buffer.from(xPaymentHeader, "base64").toString("utf-8")
    ) as {
      x402Version: number;
      scheme: string;
      network: string;
      payload: { serializedTransaction: string };
    };

    const txBuffer = Buffer.from(paymentData.payload.serializedTransaction, "base64");
    const tx = Transaction.from(txBuffer);

    // Submit the transaction
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value.err) return false;

    // Verify the confirmed tx transferred enough lamports to recipient
    const confirmedTx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!confirmedTx) return false;

    const accountKeys = confirmedTx.transaction.message.staticAccountKeys ?? 
      (confirmedTx.transaction.message as any).accountKeys;
    const recipientIndex = accountKeys.findIndex((k: PublicKey) =>
      k.equals(RECIPIENT)
    );
    if (recipientIndex === -1) return false;

    const pre = confirmedTx.meta?.preBalances[recipientIndex] ?? 0;
    const post = confirmedTx.meta?.postBalances[recipientIndex] ?? 0;
    return post - pre >= PAYMENT_LAMPORTS;
  } catch (e) {
    console.error("Payment verification error:", e);
    return false;
  }
}

app.get("/task-brief/:taskId", async (req, res) => {
  const { taskId } = req.params;
  const xPayment = req.header("X-Payment");

  if (!xPayment) {
    return res.status(402).json({
      x402Version: 1,
      error: "Payment required",
      accepts: [
        {
          scheme: "exact",
          network: "solana-devnet",
          maxAmountRequired: PAYMENT_LAMPORTS.toString(),
          resource: `http://localhost:${PORT}/task-brief/${taskId}`,
          description: `Pay ${PAYMENT_LAMPORTS} lamports to access task brief`,
          mimeType: "application/json",
          payTo: RECIPIENT.toBase58(),
          maxTimeoutSeconds: 60,
          asset: "native-sol",
          extra: { name: "SOL", version: "1" },
        },
      ],
    });
  }

  const valid = await verifyPayment(xPayment);
  if (!valid) {
    return res.status(402).json({ error: "Payment verification failed" });
  }

  const brief = TASK_BRIEFS[taskId];
  if (!brief) {
    return res.status(404).json({ error: "Task not found" });
  }

  console.log(`✅ Payment verified for task ${taskId}`);
  return res.json({ data: brief });
});

app.listen(PORT, () => {
  console.log(`x402 stub server listening on :${PORT}`);
  console.log(`Recipient: ${RECIPIENT.toBase58()}`);
  console.log(`Required payment: ${PAYMENT_LAMPORTS} lamports`);
});
