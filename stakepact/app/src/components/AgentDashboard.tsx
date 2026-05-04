import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import {
  useStakePactProgram,
  getTaskPDA,
  getBondVaultPDA,
  getAgentProfilePDA,
  getTaskStatus,
  type TaskAccount,
  type AgentProfileAccount,
} from "../program/StakePactProgram";

const X402_SERVER_URL = import.meta.env.VITE_X402_SERVER_URL ?? "http://localhost:3402";

export function AgentDashboard() {
  const { publicKey, connected } = useWallet();
  const program = useStakePactProgram();
  const [openTasks, setOpenTasks] = useState<TaskAccount[]>([]);
  const [myAcceptedTasks, setMyAcceptedTasks] = useState<TaskAccount[]>([]);
  const [profile, setProfile] = useState<AgentProfileAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Submit result form
  const [selectedTask, setSelectedTask] = useState<TaskAccount | null>(null);
  const [resultHash, setResultHash] = useState("");

  useEffect(() => {
    if (publicKey && program) {
      loadAgentData();
    }
  }, [publicKey, program]);

  async function loadAgentData() {
    if (!publicKey || !program) return;
    setLoading(true);
    setError(null);

    try {
      // Load profile
      const [profilePda] = getAgentProfilePDA(publicKey);
      try {
        const prof = await (program.account as any).agentProfile.fetch(profilePda) as AgentProfileAccount;
        setProfile(prof);
      } catch (e) {
        setProfile(null);
      }

      // Load open tasks (demo: scan first 10 tasks from operators)
      const foundOpen: TaskAccount[] = [];
      const foundAccepted: TaskAccount[] = [];

      for (let i = 1; i <= 10; i++) {
        // Try to find tasks - in a real app this would query a task index
        // For demo, we'll try a hardcoded dev wallet
        const demoOperator = new PublicKey("11111111111111111111111111111111");
        try {
          const [taskPda] = getTaskPDA(demoOperator, i);
          const task = await (program.account as any).task.fetch(taskPda) as TaskAccount;
          const status = getTaskStatus(task);

          if (status === "Open") {
            foundOpen.push(task);
          } else if (status === "Accepted" && task.agent.equals(publicKey)) {
            foundAccepted.push(task);
          }
        } catch (e) {
          // Task doesn't exist
        }
      }

      setOpenTasks(foundOpen);
      setMyAcceptedTasks(foundAccepted);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function acceptTaskViaX402(task: TaskAccount, operator: PublicKey) {
    setLoading(true);
    setError(null);

    try {
      // Build x402 fetch client using the wallet adapter's private key from env
      // (In production, agents run server-side with a keypair; browser demo uses VITE_AGENT_PRIVATE_KEY)
      const agentPrivateKey = import.meta.env.VITE_AGENT_PRIVATE_KEY as string;
      if (!agentPrivateKey) throw new Error("Set VITE_AGENT_PRIVATE_KEY in .env to use x402");

      const svmSigner = await createKeyPairSignerFromBytes(base58.decode(agentPrivateKey));
      const client = new x402Client();
      registerExactSvmScheme(client, { signer: svmSigner });
      const fetchWithPayment = wrapFetchWithPayment(fetch, client);

      // x402: fetch task brief — payment handled automatically
      const res = await fetchWithPayment(`${X402_SERVER_URL}/task-brief/${task.taskId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(`x402 request failed: ${JSON.stringify(err)}`);
      }
      const { data } = await res.json();
      console.log("x402: Task brief received", data);

      // Call accept_task on-chain
      const [taskPda] = getTaskPDA(operator, Number(task.taskId));
      const [bondVaultPda] = getBondVaultPDA(taskPda);
      const [agentProfilePda] = getAgentProfilePDA(publicKey!);

      const acceptTx = await program!.methods
        .acceptTask(Number(task.taskId))
        .accounts({
          task: taskPda,
          bondVault: bondVaultPda,
          agentProfile: agentProfilePda,
          agent: publicKey!,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setTxSig(acceptTx);
      await loadAgentData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitResult(task: TaskAccount) {
    if (!publicKey || !program) return;
    setLoading(true);
    setError(null);

    try {
      const hashBytes = new Uint8Array(32);
      const hashInput = Buffer.from(resultHash || "demo-result", "utf8");
      hashInput.forEach((b, i) => hashBytes[i % 32] = (hashBytes[i % 32] + b) % 256);

      const [taskPda] = getTaskPDA(task.operator, Number(task.taskId));

      const tx = await program.methods
        .submitResult(Number(task.taskId), Array.from(hashBytes))
        .accounts({
          task: taskPda,
          agent: publicKey,
        })
        .rpc();

      setTxSig(tx);
      setSelectedTask(null);
      setResultHash("");
      await loadAgentData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (!connected) {
    return (
      <div className="dashboard">
        <h2>Agent Dashboard</h2>
        <p>Please connect your wallet to continue.</p>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    Open: "bg-green-100 text-green-800",
    Accepted: "bg-blue-100 text-blue-800",
    Submitted: "bg-yellow-100 text-yellow-800",
    Verified: "bg-purple-100 text-purple-800",
    Slashed: "bg-red-100 text-red-800",
  };

  return (
    <div className="dashboard">
      <div className="header">
        <h2>Agent Dashboard</h2>
        <p className="address">{publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}</p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {txSig && (
        <div className="alert success">
          Transaction:{" "}
          <a
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {txSig.slice(0, 20)}...
          </a>
          <button onClick={() => setTxSig(null)}>×</button>
        </div>
      )}

      {profile && (
        <div className="profile-card">
          <h3>Agent Profile</h3>
          <div className="profile-stats">
            <div>
              <span className="stat-value">{profile.totalTasks}</span>
              <span className="stat-label">Total Tasks</span>
            </div>
            <div>
              <span className="stat-value">{profile.completedTasks}</span>
              <span className="stat-label">Completed</span>
            </div>
            <div>
              <span className="stat-value">{profile.slashedTasks}</span>
              <span className="stat-label">Slashed</span>
            </div>
            <div>
              <span className="stat-value">{profile.reliabilityScore}%</span>
              <span className="stat-label">Reliability</span>
            </div>
          </div>
        </div>
      )}

      <div className="tasks-section">
        <h3>Open Tasks</h3>
        {loading ? (
          <p>Loading...</p>
        ) : openTasks.length === 0 ? (
          <p className="empty">No open tasks available.</p>
        ) : (
          <div className="task-cards">
            {openTasks.map((task, idx) => (
              <div key={idx} className="task-card">
                <div className="task-header">
                  <span className="task-id">Task #{task.taskId}</span>
                  <span className={`status ${statusColors[getTaskStatus(task)]}`}>
                    {getTaskStatus(task)}
                  </span>
                </div>
                <div className="task-details">
                  <div>
                    <span className="label">Bond Required:</span>
                    {(Number(task.bondAmount) / LAMPORTS_PER_SOL).toFixed(4)} SOL
                  </div>
                  <div>
                    <span className="label">Reward:</span>
                    {(Number(task.rewardAmount) / LAMPORTS_PER_SOL).toFixed(4)} SOL
                  </div>
                  <div>
                    <span className="label">Deadline:</span>
                    {new Date(Number(task.deadline) * 1000).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => acceptTaskViaX402(task, task.operator)}
                  disabled={loading}
                  className="primary"
                >
                  Accept Task (x402)
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tasks-section">
        <h3>My Accepted Tasks</h3>
        {myAcceptedTasks.length === 0 ? (
          <p className="empty">No accepted tasks.</p>
        ) : (
          <div className="task-cards">
            {myAcceptedTasks.map((task, idx) => {
              const status = getTaskStatus(task);
              return (
                <div key={idx} className="task-card">
                  <div className="task-header">
                    <span className="task-id">Task #{task.taskId}</span>
                    <span className={`status ${statusColors[status]}`}>
                      {status}
                    </span>
                  </div>
                  <div className="task-details">
                    <div>
                      <span className="label">Deadline:</span>
                      {new Date(Number(task.deadline) * 1000).toLocaleString()}
                    </div>
                  </div>
                  {status === "Accepted" && (
                    <button
                      onClick={() => setSelectedTask(task)}
                      className="secondary"
                    >
                      Submit Result
                    </button>
                  )}
                  {status === "Submitted" && (
                    <p className="hint">Awaiting oracle verification...</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedTask && (
        <div className="modal">
          <div className="modal-content">
            <h3>Submit Result for Task #{selectedTask.taskId}</h3>
            <div className="form-group">
              <label>Result Hash (IPFS CID or identifier)</label>
              <input
                type="text"
                value={resultHash}
                onChange={(e) => setResultHash(e.target.value)}
                placeholder="Qm..."
              />
              <p className="hint">For demo, any text will be hashed.</p>
            </div>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setSelectedTask(null);
                  setResultHash("");
                }}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                onClick={() => submitResult(selectedTask)}
                disabled={loading || !resultHash}
                className="primary"
              >
                {loading ? "Submitting..." : "Submit"}
              </button>
            </div>
            <button
              className="modal-close"
              onClick={() => {
                setSelectedTask(null);
                setResultHash("");
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
