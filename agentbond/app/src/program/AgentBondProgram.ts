import type { Idl } from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

// Placeholder IDL - this will be loaded from the actual program
const IDL = {
  version: "0.1.0",
  name: "agentbond",
  instructions: [
    {
      name: "initializeConfig",
      accounts: [
        { name: "config", isMut: true, isSigner: false },
        { name: "authority", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "oracle", type: "publicKey" },
        { name: "treasury", type: "publicKey" },
      ],
    },
    {
      name: "createTask",
      accounts: [
        { name: "task", isMut: true, isSigner: false },
        { name: "bondVault", isMut: true, isSigner: false },
        { name: "operator", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "taskId", type: "u64" },
        { name: "bondAmount", type: "u64" },
        { name: "rewardAmount", type: "u64" },
        { name: "descriptionHash", type: { array: ["u8", 32] } },
        { name: "deadline", type: "i64" },
      ],
    },
    {
      name: "acceptTask",
      accounts: [
        { name: "task", isMut: true, isSigner: false },
        { name: "bondVault", isMut: true, isSigner: false },
        { name: "agentProfile", isMut: true, isSigner: false },
        { name: "agent", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "taskId", type: "u64" }],
    },
    {
      name: "submitResult",
      accounts: [
        { name: "task", isMut: true, isSigner: false },
        { name: "agent", isMut: false, isSigner: true },
      ],
      args: [
        { name: "taskId", type: "u64" },
        { name: "resultHash", type: { array: ["u8", 32] } },
      ],
    },
    {
      name: "verifyResult",
      accounts: [
        { name: "config", isMut: false, isSigner: false },
        { name: "task", isMut: true, isSigner: false },
        { name: "bondVault", isMut: true, isSigner: false },
        { name: "agentProfile", isMut: true, isSigner: false },
        { name: "agent", isMut: true, isSigner: false },
        { name: "operator", isMut: true, isSigner: false },
        { name: "treasury", isMut: true, isSigner: false },
        { name: "oracle", isMut: false, isSigner: true },
      ],
      args: [
        { name: "taskId", type: "u64" },
        { name: "qualityScore", type: "u8" },
        { name: "passed", type: "bool" },
      ],
    },
    {
      name: "claimExpired",
      accounts: [
        { name: "task", isMut: true, isSigner: false },
        { name: "bondVault", isMut: true, isSigner: false },
        { name: "operator", isMut: true, isSigner: true },
      ],
      args: [{ name: "taskId", type: "u64" }],
    },
  ],
  accounts: [
    {
      name: "ProgramConfig",
      type: {
        kind: "struct",
        fields: [
          { name: "oracle", type: "publicKey" },
          { name: "treasury", type: "publicKey" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "Task",
      type: {
        kind: "struct",
        fields: [
          { name: "taskId", type: "u64" },
          { name: "operator", type: "publicKey" },
          { name: "agent", type: "publicKey" },
          { name: "bondAmount", type: "u64" },
          { name: "rewardAmount", type: "u64" },
          { name: "descriptionHash", type: { array: ["u8", 32] } },
          { name: "resultHash", type: { array: ["u8", 32] } },
          { name: "status", type: { kind: "enum", variants: ["Open", "Accepted", "Submitted", "Verified", "Slashed"] } },
          { name: "deadline", type: "i64" },
          { name: "qualityScore", type: "u8" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "AgentProfile",
      type: {
        kind: "struct",
        fields: [
          { name: "agent", type: "publicKey" },
          { name: "operator", type: "publicKey" },
          { name: "totalTasks", type: "u32" },
          { name: "completedTasks", type: "u32" },
          { name: "slashedTasks", type: "u32" },
          { name: "reliabilityScore", type: "u8" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "BondVault",
      type: {
        kind: "struct",
        fields: [
          { name: "task", type: "publicKey" },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: "InvalidStatus", msg: "Task is not in the expected status" },
    { code: 6001, name: "DeadlineNotPassed", msg: "Deadline has not passed yet" },
    { code: 6002, name: "DeadlinePassed", msg: "Task deadline has already passed" },
    { code: 6003, name: "Unauthorized", msg: "Unauthorized: only the oracle can call this" },
    { code: 6004, name: "InvalidScore", msg: "Quality score must be between 0 and 100" },
  ],
  types: [],
  events: [],
  metadata: { address: "82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13" },
} as unknown as Idl;

const PROGRAM_ID = new PublicKey("82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13");
const DEFAULT_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

export const useAgentBondProgram = () => {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const program = useMemo(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;

    const connection = new Connection(DEFAULT_RPC, "confirmed");
    const wallet = {
      publicKey,
      signTransaction,
      signAllTransactions,
    };
    const provider = new AnchorProvider(connection, wallet as any, {
      commitment: "confirmed",
    });

    return new Program(IDL, provider);
  }, [publicKey, signTransaction, signAllTransactions]);

  return program;
};

export { IDL, PROGRAM_ID, DEFAULT_RPC };

// PDA derivation helpers
export const getProgramConfigPDA = () => {
  return PublicKey.findProgramAddressSync([Buffer.from("program_config")], PROGRAM_ID);
};

export const getTaskPDA = (operator: PublicKey, taskId: number) => {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), operator.toBuffer(), taskIdBuf],
    PROGRAM_ID
  );
};

export const getBondVaultPDA = (taskPubkey: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault"), taskPubkey.toBuffer()],
    PROGRAM_ID
  );
};

export const getAgentProfilePDA = (agent: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent_profile"), agent.toBuffer()],
    PROGRAM_ID
  );
};

// Type helpers
export type TaskStatus = "Open" | "Accepted" | "Submitted" | "Verified" | "Slashed";

export interface TaskAccount {
  taskId: bigint;
  operator: PublicKey;
  agent: PublicKey;
  bondAmount: bigint;
  rewardAmount: bigint;
  descriptionHash: number[];
  resultHash: number[];
  status: { Open?: {} } | { Accepted?: {} } | { Submitted?: {} } | { Verified?: {} } | { Slashed?: {} };
  deadline: bigint;
  qualityScore: number;
  bump: number;
}

export interface AgentProfileAccount {
  agent: PublicKey;
  operator: PublicKey;
  totalTasks: number;
  completedTasks: number;
  slashedTasks: number;
  reliabilityScore: number;
  bump: number;
}

export function getTaskStatus(task: TaskAccount): TaskStatus {
  const keys = Object.keys(task.status) as TaskStatus[];
  return keys[0] || "Open";
}
