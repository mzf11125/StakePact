# AgenTrade — Product Requirements Document

**agentrade.co** | Colosseum Frontier 2026 | Superteam Agentic Engineering Grant

---

## Problem

$2.4T in ASEAN commodity trade — palm oil, rubber, coffee, rice — is coordinated over WhatsApp and paper. AI agents can automate the repetitive work: price discovery, bill of lading verification, logistics quotes, customs document checks. But operators won't delegate real trade tasks to agents without accountability. One wrong price quote or fraudulent document costs thousands of dollars.

There is no on-chain accountability layer for AI agents doing real work.

---

## Solution

AgenTrade is a bonded agent protocol on Solana. Agents post SOL as a bond before accepting any trade task. If they deliver — bond returned plus reward. If they fail or cheat — bond slashed, split between operator and treasury.

Three primitives:
1. **Bond vault** — agent locks SOL on-chain before seeing task details
2. **x402 task brief** — agent pays per-task micropayment via PayAI to access the brief
3. **Oracle verification** — designated oracle checks result hash (IPFS CID) and signs release or slash

---

## Users

**Operator** — ASEAN commodity exporter. Posts trade tasks with SOL reward. Wants reliable, accountable agents. Gets slashing proceeds if agent fails.

**Agent** — autonomous AI agent (or human acting as one). Posts bond, reads task brief via x402, completes work, submits IPFS result hash. Earns reward on success.

**Oracle** — trusted verifier. Checks submitted result against task requirements. Signs release or slash transaction. First version: single keypair. Future: decentralized oracle network.

---

## Core Flows

### Create Task
```
Operator → create_task(task_id, bond_amount, reward_amount, description_hash, deadline)
→ reward locked in Task PDA
→ task status: Open
```

### Accept Task
```
Agent → pays x402 fee → reads task brief
Agent → accept_task(task_id)
→ bond transferred to BondVault PDA
→ task status: Accepted
```

### Submit Result
```
Agent → submit_result(task_id, result_hash)
→ IPFS CID of completed work stored on-chain
→ task status: Submitted
```

### Verify (Oracle)
```
Oracle → verify_result(task_id, passed)
→ passed: bond + reward → agent wallet, task status: Verified
→ failed: bond slashed → 50% operator, 50% treasury, task status: Slashed
```

### Claim Expired
```
Operator → claim_expired(task_id) [after deadline]
→ reward returned to operator
→ bond slashed (agent missed deadline)
```

---

## On-Chain State

```rust
Task {
    task_id: u64,
    operator: Pubkey,
    agent: Pubkey,
    bond_amount: u64,       // lamports
    reward_amount: u64,     // lamports
    description_hash: [u8; 32],  // IPFS CID of task brief
    result_hash: [u8; 32],       // IPFS CID of submitted result
    status: TaskStatus,     // Open | Accepted | Submitted | Verified | Slashed
    deadline: i64,
    bump: u8,
}

AgentProfile {
    agent: Pubkey,
    total_tasks: u32,
    completed_tasks: u32,
    slashed_tasks: u32,
    reliability_score: u8,  // (completed / total) * 100
    bump: u8,
}
```

PDA seeds:
- Task: `[b"task", operator, task_id_le_bytes]`
- BondVault: `[b"bond_vault", task_pubkey]`
- AgentProfile: `[b"agent_profile", agent_pubkey]`

---

## Architecture

```
Operator (Exporter)
    │
    ▼
Solana Program (Anchor)  ◄──── Oracle (TypeScript)
    │
BondVault PDA
    │
Trade Agent ◄──── x402 Server (PayAI)
```

---

## Trade Task Types (v1)

| Task | Description | Typical reward |
|------|-------------|----------------|
| Price discovery | Check spot price for commodity across 3+ exchanges | 0.1–0.5 SOL |
| Document verification | Validate bill of lading fields against shipment data | 0.2–1 SOL |
| Logistics quote | Get freight quotes from 3+ carriers for a route | 0.1–0.3 SOL |
| Customs check | Verify HS codes and duties for a shipment | 0.2–0.5 SOL |

---

## Hackathon Scope (5 days)

- [x] Anchor program: create_task, accept_task, submit_result, verify_result, claim_expired
- [x] BondVault PDA with native SOL (no token account)
- [x] AgentProfile with reliability score
- [x] Oracle service (TypeScript, single keypair)
- [x] x402 server + client (PayAI)
- [x] React frontend: operator dashboard + agent dashboard
- [ ] Demo: one end-to-end trade task on devnet (price discovery for palm oil)
- [ ] 2-min demo video

---

## Revenue Model (post-hackathon)

- Protocol fee: 1% of every slashed bond → treasury
- Oracle fee: operators pay per verification
- Future: decentralized oracle network with staked verifiers

---

## Why Solana

- Sub-cent transaction fees make per-task micropayments viable
- x402 + PayAI already live on Solana
- Superteam Indonesia community = direct distribution to ASEAN builders and exporters
- Colosseum Frontier + Superteam Agentic Engineering Grant = aligned funding

---

## Competitive Landscape

| Protocol | What they do | What's missing |
|----------|-------------|----------------|
| PayAI | x402 payment rails | No bonding, no slashing, no accountability |
| Nevermined | Agent virtual cards + metering | No on-chain enforcement, not Solana-native |
| Fetch.ai / Olas | Agent discovery + coordination | No economic accountability layer |
| AgenTrade | Bonded accountability + ASEAN trade vertical | — |
