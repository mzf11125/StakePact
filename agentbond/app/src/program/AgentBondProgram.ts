import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import IDL from "./agentbond.json";

const PROGRAM_ID = new PublicKey("82CcH55vDyFmZQC96gEPPEcWFSidKvBm92zdo7e8Xu13");
const DEFAULT_RPC = (import.meta.env?.VITE_SOLANA_RPC_URL as string) ?? "https://api.devnet.solana.com";

export const useAgentBondProgram = () => {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const program = useMemo(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;

    const connection = new Connection(DEFAULT_RPC, "confirmed");
    const wallet = { publicKey, signTransaction, signAllTransactions };
    const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    try {
      return new Program(IDL as any, provider);
    } catch (e) {
      console.error("Failed to create Program:", e);
      return null;
    }
  }, [publicKey, signTransaction, signAllTransactions]);

  return program;
};

export { IDL, PROGRAM_ID, DEFAULT_RPC };

export const getProgramConfigPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from("program_config")], PROGRAM_ID);

export const getTaskPDA = (operator: PublicKey, taskId: number) => {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), operator.toBuffer(), taskIdBuf],
    PROGRAM_ID
  );
};

export const getBondVaultPDA = (taskPubkey: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("bond_vault"), taskPubkey.toBuffer()],
    PROGRAM_ID
  );

export const getAgentProfilePDA = (agent: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("agent_profile"), agent.toBuffer()],
    PROGRAM_ID
  );

export type TaskStatus = "Open" | "Accepted" | "Submitted" | "Verified" | "Slashed";

export interface TaskAccount {
  taskId: bigint;
  operator: PublicKey;
  agent: PublicKey;
  bondAmount: bigint;
  rewardAmount: bigint;
  descriptionHash: number[];
  resultHash: number[];
  status: { open?: {} } | { accepted?: {} } | { submitted?: {} } | { verified?: {} } | { slashed?: {} };
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
  const key = Object.keys(task.status)[0];
  // Anchor 0.32 returns camelCase enum variants
  const map: Record<string, TaskStatus> = {
    open: "Open", accepted: "Accepted", submitted: "Submitted",
    verified: "Verified", slashed: "Slashed",
    Open: "Open", Accepted: "Accepted", Submitted: "Submitted",
    Verified: "Verified", Slashed: "Slashed",
  };
  return map[key] ?? "Open";
}
