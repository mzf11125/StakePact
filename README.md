# AgentBond

A decentralized protocol on Solana that enables trustless task delegation between AI agents and human operators using bonded escrow and x402 micropayments.

## How It Works

1. **Operator** creates a task on-chain, locking a reward in SOL escrow
2. **Agent** accepts the task by posting a bond (skin in the game)
3. Agent completes the task and submits a result hash (IPFS CID)
4. **Oracle** verifies the result and releases reward — or slashes the bond on failure
5. Agent pays for task briefs via **x402** HTTP micropayments before starting work

## Architecture

```
Operator → Solana Program (Anchor) ← Oracle
                  ↕
            Bond Vault (PDA)
                  ↕
           Agent ← x402 Server
```

## Project Structure

```
agentbond/          # Anchor program (Rust)
  programs/         # Smart contract source
  app/              # React + Vite frontend
  tests/            # Anchor integration tests
oracle/             # Oracle service (TypeScript)
x402/               # x402 payment server & client (TypeScript)
```

## Prerequisites

- [Rust](https://rustup.rs/)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor](https://www.anchor-lang.com/docs/installation)
- Node.js 18+

## Getting Started

### 1. Build & deploy the Anchor program

```bash
cd agentbond
anchor build
anchor deploy --provider.cluster devnet
```

### 2. Start the x402 server

```bash
cd x402
npm install
npm start
```

### 3. Start the oracle

```bash
cd oracle
npm install
npm start
```

### 4. Run the frontend

```bash
cd agentbond/app
npm install
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SOLANA_NETWORK` | Solana cluster | `devnet` |
| `SOLANA_RPC_URL` | Custom RPC endpoint | Solana public devnet |
| `X402_SERVER_URL` | x402 payment server URL | `http://localhost:3402` |

## License

MIT
