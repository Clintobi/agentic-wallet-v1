/**
 * src/agent.js
 *
 * Autonomous agent runner — runs multiple concurrent agents, each with a
 * different strategy, using the skill registry for all actions.
 *
 * Architecture (stolen from awal + AgentKit):
 *   - Each agent has a role (trader_bear, trader_bull, lp_sentinel, yield_farmer)
 *   - Market signal drives the decision (bullish/bearish/neutral)
 *   - Policy engine gates every action before execution
 *   - All agents run concurrently via Promise.allSettled
 *   - Results streamed to dashboard via SSE
 *
 * Run: node src/agent.js --agents 4
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

// Load all skills
import "./skills/balance.js";
import "./skills/transfer.js";
import "./skills/jupiter.js";
import "./skills/marginfi.js";
import "./skills/marinade.js";

import { execute }           from "./skills/registry.js";
import { loadPolicy }        from "./policy.js";
import { loadOrCreateKeypair, createKeypairSigner } from "./signing/keypairSigner.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── Agent roles ───────────────────────────────────────────────────────────────

const ROLES = {
  trader_bear: {
    description: "Sells SOL for USDC when neutral/bearish signal",
    async act(signal, context) {
      if (signal.sentiment === "bullish") return { decision: "skip", reason: "wrong_signal_for_role" };
      return execute("jupiter_swap", {
        inputMint:  "SOL",
        outputMint: "USDC",
        amountSol:  0.1,
      }, context);
    },
  },
  trader_bull: {
    description: "Buys SOL with USDC when bullish signal",
    async act(signal, context) {
      if (signal.sentiment === "bearish") return { decision: "skip", reason: "wrong_signal_for_role" };
      return execute("jupiter_swap", {
        inputMint:  "USDC",
        outputMint: "SOL",
        amountSol:  0.1,
      }, context);
    },
  },
  lp_sentinel: {
    description: "Monitors SOL price and lending rates, no fund movement",
    async act(signal, context) {
      const [price, rates] = await Promise.all([
        execute("get_sol_price",      {}, context),
        execute("marginfi_get_rates", { token: "USDC" }, context),
      ]);
      const recommendation = price.data?.price > 140 ? "lp_add" : "lp_reduce";
      return { decision: recommendation, price: price.data, rates: rates.data };
    },
  },
  yield_farmer: {
    description: "Stakes idle SOL in Marinade for yield when signal is neutral",
    async act(signal, context) {
      if (signal.sentiment !== "neutral") return { decision: "skip", reason: "waiting_for_neutral_market" };
      const [rate, result] = await Promise.all([
        execute("get_stake_rate", {}, context),
        execute("marinade_stake", { amountSol: 0.05 }, context),
      ]);
      return { decision: "staked", rate: rate.data, stake: result };
    },
  },
};

const ROLE_CYCLE = ["trader_bear", "trader_bull", "lp_sentinel", "yield_farmer"];

// ── Market signal ─────────────────────────────────────────────────────────────

function generateSignal() {
  // Deterministic signal based on 5-minute time windows — consistent within a window
  const slot  = Math.floor(Date.now() / (1000 * 60 * 5));
  const score = parseFloat(((Math.sin(slot * 1.3) + 1) / 2).toFixed(3));
  const sentiment = score > 0.65 ? "bullish" : score < 0.35 ? "bearish" : "neutral";
  return { score, sentiment, generatedAt: Date.now() };
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function runAgents({ agentCount = 3, signer, onResult } = {}) {
  const signal = generateSignal();
  console.error(`[agent] signal: ${signal.sentiment} (${signal.score})`);

  const tasks = Array.from({ length: agentCount }, (_, i) => {
    const agentId = `agent-${i + 1}`;
    const role    = ROLE_CYCLE[i % ROLE_CYCLE.length];
    const context = { signer, agentId };

    return (async () => {
      console.error(`[${agentId}] role=${role} starting`);
      const t0     = Date.now();
      const result = await ROLES[role].act(signal, context);
      const elapsed = Date.now() - t0;
      const entry = { agentId, role, signal, elapsed, ...result };
      onResult?.(entry);
      return entry;
    })();
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map(s => s.status === "fulfilled" ? s.value : { ok: false, error: s.reason?.message });
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  }

  loadPolicy(path.join(__dir, "../policy.json"));
  const keypair = loadOrCreateKeypair(path.join(__dir, "../wallet.enc.json"));
  const signer  = createKeypairSigner(keypair);
  const count   = Number(arg("agents", 3));

  console.error(`[agent] wallet: ${signer.publicKey.toBase58()}`);
  console.error(`[agent] launching ${count} agents concurrently`);

  const t0      = Date.now();
  const results = await runAgents({ agentCount: count, signer });
  console.error(`[agent] all done in ${Date.now() - t0}ms`);
  console.log(JSON.stringify({ ok: true, results, elapsedMs: Date.now() - t0 }, null, 2));
}
