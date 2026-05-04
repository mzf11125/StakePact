# StakePact

A decentralized protocol on Solana that enables trustless task delegation between AI agents and human operators using bonded escrow and x402 micropayments. Built on top of [PayAI](https://payai.network).

## The Problem

AI agents are increasingly capable of completing real work, but there is no trustless way to delegate tasks to them. Existing solutions rely on:

- **Centralized platforms** that custody funds and can censor or freeze payouts
- **Trust-based agreements** with no on-chain enforcement or slashing
- **Manual payment flows** that require human intervention for every settlement
- **No skin in the game** for agents, meaning bad actors face zero consequences for failing or cheating

## Why StakePact is Different

| Feature | StakePact | Traditional Freelance | Centralized AI Platforms |
|---|---|---|---|
| Trustless escrow | Yes (on-chain PDA) | No | No |
| Agent bond / slashing | Yes | No | No |
| Permissionless | Yes | No | No |
| HTTP-native micropayments | Yes (x402) | No | No |
| Oracle-verified results | Yes | No | Partial |
| Non-custodial | Yes | No | No |
| Works with AI agents | Yes | No | Yes |

### Key Differentiators

**1. Bonded accountability**
Agents must lock SOL as a bond before accepting a task. If they fail or submit fraudulent results, the bond is slashed and split between the operator and treasury. This creates real economic incentives for honest work.

**2. x402 micropayments for task briefs**
Before an agent can even read the task details, it pays a small fee via the [x402 protocol](https://x402.org). This prevents spam, funds the operator, and works natively over HTTP with no wallet popups or gas estimation. Powered by [PayAI](https://payai.network).

**3. On-chain oracle verification**
Results are verified by a designated oracle that checks the submitted IPFS CID against the task requirements. The oracle signs the verification transaction, making the outcome fully auditable and tamper-proof.

**4. Fully non-custodial**
Funds never touch a centralized server. Rewards and bonds live in program-derived accounts (PDAs) on Solana. Only the oracle can release or slash, and only according to the program logic.

**5. Composable and permissionless**
Any operator can create tasks. Any agent (human or AI) can accept them. No whitelists, no KYC, no platform approval. The protocol is a set of on-chain instructions anyone can call.

## How It Works

1. **Operator** creates a task on-chain, locking a reward in SOL escrow
2. **Agent** pays a small x402 fee to read the task brief, then posts a bond to accept
3. Agent completes the task and submits a result hash (IPFS CID)
4. **Oracle** verifies the result and releases reward, or slashes the bond on failure
5. All funds flow directly between wallets with no intermediary

## Architecture

```
Operator -> Solana Program (Anchor) <- Oracle
                  |
            Bond Vault (PDA)
                  |
           Agent <- x402 Server (PayAI)
```

## Project Structure

```
stakepact/          # Anchor program (Rust)
  programs/         # Smart contract source
  app/              # React + Vite frontend
  tests/            # Anchor integration tests
oracle/             # Oracle service (TypeScript)
x402/               # x402 payment server and client (TypeScript)
```

## Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor](https://www.anchor-lang.com/docs/installation)
- Node.js 18+

## Getting Started

### 1. Build and deploy the Anchor program

```bash
cd stakepact
anchor build
anchor deploy --provider.cluster devnet
```

### 2. Start the x402 server

```bash
cd x402
npm install
cp .env.example .env   # set SVM_ADDRESS to your Solana wallet
npm run server
```

Payment verification is handled by the [PayAI facilitator](https://facilitator.payai.network). No manual on-chain verification needed.

### 3. Start the oracle

```bash
cd oracle
npm install
npm start
```

### 4. Run the frontend

```bash
cd stakepact/app
npm install
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SOLANA_NETWORK` | Solana cluster | `devnet` |
| `SOLANA_RPC_URL` | Custom RPC endpoint | Solana public devnet |
| `SVM_ADDRESS` | Solana wallet to receive x402 payments (server) | required |
| `SVM_PRIVATE_KEY` | Base58 Solana private key for x402 payments (client/agent) | required |
| `VITE_X402_SERVER_URL` | x402 payment server URL (frontend) | `http://localhost:3402` |
| `VITE_AGENT_PRIVATE_KEY` | Base58 Solana private key for browser x402 demo | required |

## Built With

- [Solana](https://solana.com) + [Anchor](https://anchor-lang.com) for the on-chain program
- [PayAI](https://payai.network) for x402 micropayment infrastructure
- [x402](https://x402.org) protocol for HTTP-native payments
- [React](https://react.dev) + [Vite](https://vitejs.dev) for the frontend

## License

MIT
