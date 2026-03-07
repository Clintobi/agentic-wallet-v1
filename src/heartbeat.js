/**
 * src/heartbeat.js
 *
 * Heartbeat engine — agents run continuously, autonomously.
 * No button click needed. Each agent polls on its own interval.
 *
 * Inspired by KLAVE's heartbeat system:
 *   - Each agent has a heartbeat_interval (seconds)
 *   - On each tick: generate market signal → evaluate policy → execute skill
 *   - State persisted to SQLite after every tick
 *   - Emits events to SSE/WebSocket clients for live dashboard updates
 *
 * Usage:
 *   import { HeartbeatEngine } from "./heartbeat.js";
 *   const engine = new HeartbeatEngine({ treasurySigner, broadcast });
 *   engine.start();        // starts all registered agents
 *   engine.stop();         // stops all
 *   engine.stopAgent(id);  // stop one agent
 */

import { v4 as uuidv4 } from "uuid";
import { getAllAgents, setAgentStatus, heartbeat, getAgentSigner } from "./agents.js";
import { execute } from "./skills/registry.js";
import { loadPolicy, getPolicy, isPaused, isAgentFrozen } from "./policy.js";
import { getBalanceSol } from "./wallet.js";
import { agentQueries, txQueries, spendQueries, logEvent, recordTx, get24hSpend, getLastTxTime } from "./db.js";
import { runGuardianTick }  from "./skills/guardian.js";
import { runAccountantTick } from "./skills/accountant.js";
import { runAutopilotTick }  from "./skills/autopilot.js";
import { runFarmerTick }     from "./skills/airdrop_farmer.js";
import { socialTick }        from "./skills/social.js";

// ── Market signal generator ───────────────────────────────────────────────────

function generateSignal() {
  const slot  = Math.floor(Date.now() / (1000 * 60 * 5)); // 5-min window
  const score = parseFloat(((Math.sin(slot * 1.3) + 1) / 2).toFixed(3));
  const sentiment = score > 0.65 ? "bullish" : score < 0.35 ? "bearish" : "neutral";
  return { score, sentiment, ts: Date.now() };
}

// ── Role action dispatch ──────────────────────────────────────────────────────

async function dispatchRole(role, signal, context) {
  switch (role) {
    // ── Original trading roles ────────────────────────────────────────────────
    case "trader_bear":
      if (signal.sentiment === "bullish") return { decision: "skip", reason: "signal_wrong_for_role" };
      return execute("jupiter_swap", { inputMint: "SOL", outputMint: "USDC", amountSol: 0.05 }, context);

    case "trader_bull":
      if (signal.sentiment === "bearish") return { decision: "skip", reason: "signal_wrong_for_role" };
      return execute("jupiter_swap", { inputMint: "USDC", outputMint: "SOL", amountSol: 0.05 }, context);

    case "lp_sentinel": {
      const [price, rates] = await Promise.all([
        execute("get_sol_price",      {}, context),
        execute("marginfi_get_rates", { token: "USDC" }, context),
      ]);
      const rec = (price?.price ?? 0) > 140 ? "lp_add" : "lp_reduce";
      return { decision: rec, price: price?.price, rates: rates?.depositApy };
    }

    case "yield_farmer":
      if (signal.sentiment !== "neutral") return { decision: "skip", reason: "waiting_for_neutral" };
      return execute("marinade_stake", { amountSol: 0.02 }, context);

    case "watchdog": {
      const bal = await getBalanceSol(context.signer.publicKey.toBase58()).catch(() => null);
      const alert = bal !== null && bal < 0.1;
      logEvent("watchdog_check", { balance: bal, alert }, context.agentId);
      return { decision: alert ? "low_balance_alert" : "ok", balance: bal };
    }

    // ── New use-case roles ────────────────────────────────────────────────────
    case "guardian":
      return runGuardianTick(context);

    case "accountant":
      return runAccountantTick(context);

    case "autopilot":
      return runAutopilotTick(context, signal);

    case "airdrop_farmer":
      return runFarmerTick(context);

    case "social":
      return socialTick(context);

    default:
      return { decision: "skip", reason: "unknown_role" };
  }
}

// ── Role → skill name map (for DB records) ────────────────────────────────────

const skillMap = {
  trader_bear:   "jupiter_swap",
  trader_bull:   "jupiter_swap",
  lp_sentinel:   "lp_analysis",
  yield_farmer:  "marinade_stake",
  watchdog:      "watchdog_check",
  guardian:      "guardian_check",
  accountant:    "balance_snapshot",
  autopilot:     "rule_evaluation",
  airdrop_farmer:"protocol_touch",
  social:        "payment_polling",
};

// ── Analysis-only roles (no on-chain tx) ─────────────────────────────────────

const analysisRoles = new Set([
  "lp_sentinel", "watchdog", "guardian", "accountant",
  "autopilot", "airdrop_farmer", "social",
]);

const liveSwapRoles = new Set(["trader_bear", "trader_bull"]);

function classifyTxStatus({ result, sig, isAnalysisOnly }) {
  const reason = String(result?.reason || result?.error || "").toLowerCase();
  const note = String(result?.note || "").toLowerCase();

  if (reason.includes("no_route")) return "no_route";
  if (result?.ok === false && result?.blocked) return "blocked";
  if (isAnalysisOnly) return "analysis";
  if (sig) return "confirmed";
  if (result?.ok === false) return "failed";

  const simulated = result?.swapped === false
    || result?.staked === true
    || result?.deposited === true
    || result?.borrowed === true
    || note.includes("devnet: ")
    || reason.includes("no_route")
    || reason.includes("unsupported_network");

  if (simulated) return "simulated";
  return "submitted";
}

function shouldPersistHeartbeatResult({ decision, result, isAnalysisOnly }) {
  if (decision === "skip" || decision === "ok" || decision === "idle" || decision === "no_rules") {
    return false;
  }
  if (!isAnalysisOnly) return true;
  if (result?.ok === false || result?.blocked) return true;
  if (result?.sig) return true;
  if (Number(result?.alerts || 0) > 0) return true;
  if (Number(result?.rulesFired || 0) > 0) return true;
  if (Number(result?.checked || 0) > 0 && Number(result?.stillPending || 0) > 0) return true;

  const threat = String(result?.threatLevel || "").toLowerCase();
  if (threat === "warning" || threat === "critical") return true;
  return false;
}

// ── HeartbeatEngine ───────────────────────────────────────────────────────────

export class HeartbeatEngine {
  constructor({ treasurySigner, broadcast = () => {} }) {
    this.treasurySigner = treasurySigner;
    this.broadcast      = broadcast;
    this.timers         = new Map(); // agentId → NodeJS.Timeout
    this.agentSigners   = new Map(); // agentId → signer (ephemeral, per-session)
    this.running        = false;
  }

  start() {
    this.running = true;
    const agents = getAllAgents();

    if (agents.length === 0) {
      console.log("[heartbeat] No agents registered yet.");
      return;
    }

    for (const agent of agents) {
      this._startAgent(agent);
    }

    console.log(`[heartbeat] Started ${agents.length} agents.`);
  }

  stop() {
    this.running = false;
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Mark all offline
    for (const agent of getAllAgents()) {
      setAgentStatus(agent.id, "offline");
    }
    console.log("[heartbeat] All agents stopped.");
  }

  startAgent(agentData) {
    this._startAgent(agentData);
  }

  stopAgent(agentId) {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentId);
    }
    setAgentStatus(agentId, "offline");
    this.broadcast("agent_offline", { agentId });
  }

  _startAgent(agent) {
    if (this.timers.has(agent.id)) return; // already running

    // Each agent signs with its own wallet to preserve true multi-agent
    // independence (separate keys, balances, and explorer signatures).
    const signer = getAgentSigner(agent.id, { autoProvision: true });
    if (!signer) {
      this.broadcast("agent_error", {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        reason: "agent_signer_unavailable",
      });
      return;
    }

    this.agentSigners.set(agent.id, signer);
    const signerPubkey = signer.publicKey.toBase58();

    setAgentStatus(agent.id, "online");
    this.broadcast("agent_online", {
      agentId: agent.id,
      name:    agent.name,
      role:    agent.role,
      pubkey:  signerPubkey,
    });

    const intervalMs = (agent.heartbeat_interval || 30) * 1000;

    // Run immediately on start
    this._tick(agent, signer);

    const timer = setInterval(() => {
      if (!this.running) return;
      this._tick(agent, signer);
    }, intervalMs);

    this.timers.set(agent.id, timer);
    console.log(`[heartbeat] ${agent.name} (${agent.role}) started — interval: ${agent.heartbeat_interval}s`);
  }

  async _tick(agent, signer) {
    heartbeat(agent.id);

    if (isPaused()) {
      this.broadcast("agent_paused", {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        reason: "emergency_pause_active",
      });
      return;
    }

    if (isAgentFrozen(agent.id)) {
      this.broadcast("agent_frozen_skip", {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        reason: "agent_frozen",
      });
      return;
    }

    const network = process.env.SOLANA_NETWORK || "devnet";
    if (network !== "mainnet-beta" && liveSwapRoles.has(agent.role)) {
      this.broadcast("agent_skip", {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        reason: "mainnet_required_for_live_swap",
      });
      return;
    }

    if (liveSwapRoles.has(agent.role)) {
      try {
        const balance = await getBalanceSol(signer.publicKey.toBase58());
        const reserve = Number(getPolicy()?.reserveSol || 0);
        const minRequired = reserve + 0.02;
        if (!Number.isFinite(balance) || balance <= minRequired) {
          this.broadcast("agent_skip", {
            agentId: agent.id,
            name: agent.name,
            role: agent.role,
            reason: `insufficient_balance_for_live_swap: balance=${balance?.toFixed?.(4) ?? "n/a"} reserve=${reserve}`,
          });
          return;
        }
      } catch {
        this.broadcast("agent_skip", {
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          reason: "balance_check_unavailable",
        });
        return;
      }
    }

    const signal  = generateSignal();
    const txId    = uuidv4();
    const context = {
      signer,
      agentId:   agent.id,
      agentName: agent.name,
      agentRole: agent.role,
      idempotencyKey: txId,
      broadcast: this.broadcast, // give skills access to SSE broadcast
    };

    this.broadcast("agent_tick", {
      agentId:  agent.id,
      name:     agent.name,
      role:     agent.role,
      signal,
      status:   "thinking",
    });

    let result;
    try {
      result = await dispatchRole(agent.role, signal, context);
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    // Derive a readable decision label from the result
    let decision = result?.decision;
    if (!decision) {
      if (result?.ok === false && result?.blocked) decision = "blocked";
      else if (result?.ok === false) decision = "error";
      else if (result?.sig) decision = "executed";
      else if (result?.swapped === false) decision = "no_route";
      else if (result?.staked) decision = "staked";
      else if (result?.ok === true) decision = "executed";
      else decision = "error";
    }
    const sig       = result?.sig ?? result?.data?.sig ?? null;
    const amountSol = result?.amountSol ?? result?.data?.amountSol ?? 0;

    const skillName      = skillMap[agent.role] ?? agent.role;
    const isAnalysisOnly = analysisRoles.has(agent.role);

    // Persist tx if it did something meaningful
    if (shouldPersistHeartbeatResult({ decision, result, isAnalysisOnly })) {
      const txStatus = classifyTxStatus({ result, sig, isAnalysisOnly });
      const reason = result?.reason ?? result?.error ?? null;
      const toAddr = result?.toAddress
        || result?.destination
        || result?.recipient
        || null;

      recordTx({
        id:        txId,
        agentId:   agent.id,
        skill:     skillName,
        status:    txStatus,
        sig,
        amountSol,
        token:     "SOL",
        fromAddr:  signer.publicKey.toBase58(),
        toAddr,
        details:   result,
        error:     reason,
      });

      if (amountSol > 0) {
        spendQueries.record.run(agent.id, amountSol);
        agentQueries.incrementTxCount.run(amountSol, agent.id);
      }
    }

    // Broadcast result to dashboard
    this.broadcast("agent_result", {
      agentId:  agent.id,
      name:     agent.name,
      role:     agent.role,
      signal,
      decision,
      sig,
      amountSol,
      result,
      ts:       Date.now(),
    });

    logEvent("heartbeat_tick", { agentId: agent.id, role: agent.role, decision, sig }, agent.id);
  }
}
