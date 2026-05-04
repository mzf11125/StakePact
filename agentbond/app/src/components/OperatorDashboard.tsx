import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  useAgentBondProgram,
  getProgramConfigPDA,
  getTaskPDA,
  getBondVaultPDA,
  getTaskStatus,
  type TaskAccount,
} from "../program/AgentBondProgram";

const DEFAULT_ORACLE = new PublicKey("11111111111111111111111111111111");
const DEFAULT_TREASURY = new PublicKey("11111111111111111111111111111111");

export function OperatorDashboard() {
  const { publicKey, connected } = useWallet();
  const program = useAgentBondProgram();
  const [view, setView] = useState<"create" | "tasks">("tasks");
  const [tasks, setTasks] = useState<TaskAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create task form state
  const [taskId, setTaskId] = useState("1");
  const [bondAmount, setBondAmount] = useState("0.1");
  const [rewardAmount, setRewardAmount] = useState("0.2");
  const [deadline, setDeadline] = useState("");
  const [description, setDescription] = useState("");
  const [configInitialized, setConfigInitialized] = useState(false);

  useEffect(() => {
    if (publicKey && program) {
      loadTasks();
      checkConfigInitialized();
    }
  }, [publicKey, program]);

  async function checkConfigInitialized() {
    try {
      const [configPda] = getProgramConfigPDA();
      await (program!.account as any).programConfig.fetch(configPda);
      setConfigInitialized(true);
    } catch (e) {
      setConfigInitialized(false);
    }
  }

  async function loadTasks() {
    if (!publicKey || !program) return;
    setLoading(true);
    setError(null);

    try {
      // For demo, fetch tasks 1-10 by checking if they exist
      const foundTasks: TaskAccount[] = [];
      for (let i = 1; i <= 10; i++) {
        const [taskPda] = getTaskPDA(publicKey, i);
        try {
          const task = await (program.account as any).task.fetch(taskPda) as TaskAccount;
          if (task.operator.equals(publicKey)) {
            foundTasks.push(task);
          }
        } catch (e) {
          // Task doesn't exist, skip
        }
      }
      setTasks(foundTasks);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function initializeConfig() {
    if (!publicKey || !program) {
      setError("Wallet not connected or program not loaded. Try reconnecting your wallet.");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const [configPda] = getProgramConfigPDA();
      const tx = await program.methods
        .initializeConfig(DEFAULT_ORACLE, DEFAULT_TREASURY)
        .accounts({
          config: configPda,
          authority: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setTxSig(tx);
      setConfigInitialized(true);
    } catch (e: any) {
      // Already initialized is fine
      if (e.message?.includes("already in use") || e.message?.includes("0x0")) {
        setConfigInitialized(true);
      } else {
        setError(`Initialize failed: ${e.message}`);
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  }

  async function createTask() {
    if (!publicKey || !program) return;
    setLoading(true);
    setError(null);

    try {
      const taskIdNum = parseInt(taskId);
      const bondLamports = Math.floor(parseFloat(bondAmount) * LAMPORTS_PER_SOL);
      const rewardLamports = Math.floor(parseFloat(rewardAmount) * LAMPORTS_PER_SOL);
      const deadlineSecs = Math.floor(new Date(deadline).getTime() / 1000);
      const descBytes = Buffer.from(description, "utf8");
      const descHash = new Uint8Array(32);
      descBytes.forEach((b, i) => descHash[i % 32] = (descHash[i % 32] + b) % 256);

      const [taskPda] = getTaskPDA(publicKey, taskIdNum);
      const [bondVaultPda] = getBondVaultPDA(taskPda);

      const tx = await program.methods
        .createTask(
          taskIdNum,
          bondLamports,
          rewardLamports,
          Array.from(descHash),
          deadlineSecs
        )
        .accounts({
          task: taskPda,
          bondVault: bondVaultPda,
          operator: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setTxSig(tx);
      await loadTasks();
      setView("tasks");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function claimExpired(task: TaskAccount) {
    if (!publicKey || !program) return;
    setLoading(true);
    setError(null);

    try {
      const [taskPda] = getTaskPDA(publicKey, Number(task.taskId));
      const [bondVaultPda] = getBondVaultPDA(taskPda);

      const tx = await program.methods
        .claimExpired(Number(task.taskId))
        .accounts({
          task: taskPda,
          bondVault: bondVaultPda,
          operator: publicKey,
        })
        .rpc();
      setTxSig(tx);
      await loadTasks();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (!connected) {
    return (
      <div className="dashboard">
        <h2>Operator Dashboard</h2>
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
        <h2>Operator Dashboard</h2>
        <p className="address">{publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}</p>
      </div>

      {!configInitialized && (
        <div className="alert warning">
          <p>Program config not initialized. Please initialize to continue.</p>
          <button onClick={initializeConfig} disabled={loading}>
            {loading ? "Initializing..." : "Initialize Config"}
          </button>
        </div>
      )}

      <div className="tabs">
        <button
          className={view === "create" ? "active" : ""}
          onClick={() => setView("create")}
          disabled={!configInitialized}
        >
          Create Task
        </button>
        <button
          className={view === "tasks" ? "active" : ""}
          onClick={() => setView("tasks")}
        >
          My Tasks ({tasks.length})
        </button>
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

      {view === "create" && configInitialized && (
        <div className="form-card">
          <h3>Create New Task</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Task ID</label>
              <input
                type="number"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                placeholder="1"
              />
            </div>
            <div className="form-group">
              <label>Bond Amount (SOL)</label>
              <input
                type="number"
                step="0.01"
                value={bondAmount}
                onChange={(e) => setBondAmount(e.target.value)}
                placeholder="0.1"
              />
            </div>
            <div className="form-group">
              <label>Reward Amount (SOL)</label>
              <input
                type="number"
                step="0.01"
                value={rewardAmount}
                onChange={(e) => setRewardAmount(e.target.value)}
                placeholder="0.2"
              />
            </div>
            <div className="form-group">
              <label>Deadline</label>
              <input
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Task Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task..."
              rows={4}
            />
          </div>
          <button
            onClick={createTask}
            disabled={loading}
            className="primary"
          >
            {loading ? "Creating..." : "Create Task"}
          </button>
        </div>
      )}

      {view === "tasks" && (
        <div className="tasks-list">
          <h3>My Tasks</h3>
          {loading ? (
            <p>Loading...</p>
          ) : tasks.length === 0 ? (
            <p className="empty">No tasks created yet.</p>
          ) : (
            <div className="task-cards">
              {tasks.map((task, idx) => {
                const status = getTaskStatus(task);
                const isExpired = Number(task.deadline) * 1000 < Date.now();
                return (
                  <div key={idx} className="task-card">
                    <div className="task-header">
                      <span className="task-id">Task #{task.taskId}</span>
                      <span className={`status ${statusColors[status]}`}>{status}</span>
                    </div>
                    <div className="task-details">
                      <div>
                        <span className="label">Bond:</span>
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
                      {status === "Accepted" && task.agent.toString() !== PublicKey.default.toString() && (
                        <div>
                          <span className="label">Agent:</span>
                          {task.agent.toBase58().slice(0, 8)}...
                        </div>
                      )}
                    </div>
                    {status === "Accepted" && isExpired && (
                      <button
                        onClick={() => claimExpired(task)}
                        disabled={loading}
                        className="warning"
                      >
                        Claim Expired
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
