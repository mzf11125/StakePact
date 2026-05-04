/**
 * x402 Server — powered by PayAI facilitator
 *
 * Protects /task-brief/:taskId behind a SOL micropayment.
 * Verification and settlement are handled by https://facilitator.payai.network
 *
 * Env vars:
 *   SVM_ADDRESS       - Solana wallet address to receive payments
 *   PAYMENT_USD       - price per request in USD (default: "0.001")
 *   PORT              - server port (default: 3402)
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator } from "@payai/facilitator";
import * as path from "path";

config({ path: path.join(__dirname, "../.env") });

const svmAddress = process.env.SVM_ADDRESS;
if (!svmAddress) {
  console.error("Missing required env var: SVM_ADDRESS");
  process.exit(1);
}

const PAYMENT_USD = process.env.PAYMENT_USD ?? "0.001";
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
    description: "Write a minimal Rust program that prints 'Hello, StakePact!'",
    bondAmount: 50000000,
    rewardAmount: 100000000,
  },
};

const facilitatorClient = new HTTPFacilitatorClient(facilitator);

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /task-brief/:taskId": {
        accepts: [
          {
            scheme: "exact",
            price: `$${PAYMENT_USD}`,
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // solana-devnet
            payTo: svmAddress,
          },
        ],
        description: "StakePact task brief",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      new ExactSvmScheme()
    )
  )
);

app.get("/task-brief/:taskId", (req, res) => {
  const brief = TASK_BRIEFS[req.params.taskId];
  if (!brief) return res.status(404).json({ error: "Task not found" });
  console.log(`✅ Payment verified for task ${req.params.taskId}`);
  res.json({ data: brief });
});

app.listen(PORT, () => {
  console.log(`x402 server listening on :${PORT}`);
  console.log(`Recipient: ${svmAddress}`);
  console.log(`Price: $${PAYMENT_USD} per request (via PayAI facilitator)`);
});
