/**
 * src/agents.js
 *
 * Named agent identity management.
 * Each agent has: name, keypair, role, API key, policy, heartbeat config.
 *
 * Inspired by KLAVE's agent model — agents are first-class citizens,
 * not just numbered instances.
 *
 * Agent lifecycle:
 *   create → register (saves to DB + encrypts keypair) → start heartbeat → online
 *   → execute skills → log txs → offline when heartbeat stops
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
import { agentQueries, logEvent } from "./db.js";
import {
  createKeypairSigner,
  loadEncryptedKeypair,
  saveEncryptedKeypair,
} from "./signing/keypairSigner.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const AGENT_WALLETS_DIR = path.join(__dir, "../data/agent-wallets");
const signerCache = new Map(); // agentId -> { signer, pubkey }

fs.mkdirSync(AGENT_WALLETS_DIR, { recursive: true });

function walletPathForAgent(agentId) {
  return path.join(AGENT_WALLETS_DIR, `${agentId}.enc.json`);
}

function cacheSigner(agentId, keypair) {
  const signer = createKeypairSigner(keypair);
  signerCache.set(agentId, { signer, pubkey: signer.publicKey.toBase58() });
  return signer;
}

function getCachedSigner(agentId, expectedPubkey) {
  const cached = signerCache.get(agentId);
  if (!cached) return null;
  if (expectedPubkey && cached.pubkey !== expectedPubkey) {
    signerCache.delete(agentId);
    return null;
  }
  return cached.signer;
}

// ── Agent roles ────────────────────────────────────────────────────────────────

export const AGENT_ROLES = {
  // ── Trading agents ────────────────────────────────────────────────────────
  trader_bear: {
    label:       "Trader Bear",
    color:       "#3b82f6",
    icon:        "📉",
    description: "Sells SOL→USDC on neutral/bearish signals",
    category:    "trading",
  },
  trader_bull: {
    label:       "Trader Bull",
    color:       "#10b981",
    icon:        "📈",
    description: "Buys SOL with USDC on bullish signals",
    category:    "trading",
  },
  lp_sentinel: {
    label:       "LP Sentinel",
    color:       "#8b5cf6",
    icon:        "🌊",
    description: "Monitors pools, recommends LP add/reduce actions",
    category:    "trading",
  },
  yield_farmer: {
    label:       "Yield Farmer",
    color:       "#f59e0b",
    icon:        "🌾",
    description: "Stakes idle SOL via Marinade for passive yield",
    category:    "trading",
  },
  watchdog: {
    label:       "Watchdog",
    color:       "#ef4444",
    icon:        "🐕",
    description: "Monitors wallet activity, alerts on anomalies",
    category:    "security",
  },

  // ── Autopilot ─────────────────────────────────────────────────────────────
  autopilot: {
    label:       "Autopilot",
    color:       "#06b6d4",
    icon:        "🤖",
    description: "Evaluates user-defined IF/THEN rules and fires actions automatically",
    category:    "automation",
  },

  // ── Airdrop Farmer ────────────────────────────────────────────────────────
  airdrop_farmer: {
    label:       "Airdrop Farmer",
    color:       "#a855f7",
    icon:        "🪂",
    description: "Rotates through DeFi protocols to build on-chain history for airdrops",
    category:    "farming",
  },

  // ── DeFi Accountant ───────────────────────────────────────────────────────
  accountant: {
    label:       "DeFi Accountant",
    color:       "#84cc16",
    icon:        "📊",
    description: "Takes balance snapshots, tracks yield, computes P&L over time",
    category:    "analytics",
  },

  // ── Guardian ──────────────────────────────────────────────────────────────
  guardian: {
    label:       "Guardian",
    color:       "#f43f5e",
    icon:        "🛡️",
    description: "Monitors price, balance, and tx patterns; raises severity-graded alerts",
    category:    "security",
  },

  // ── Social Wallet ─────────────────────────────────────────────────────────
  social: {
    label:       "Social Wallet",
    color:       "#f97316",
    icon:        "💸",
    description: "Generates Solana Pay payment requests and shareable Blink links",
    category:    "payments",
  },
};

// ── Create a new named agent ──────────────────────────────────────────────────

export function createAgent({ name, role = "trader_bull", heartbeatInterval = 30, policy = {} }) {
  if (!name) throw new Error("Agent name is required");
  if (!AGENT_ROLES[role]) throw new Error(`Unknown role: ${role}. Valid: ${Object.keys(AGENT_ROLES).join(", ")}`);

  // Check name uniqueness
  const existing = agentQueries.getByName.get(name);
  if (existing) throw new Error(`Agent "${name}" already exists`);

  // Generate a fresh keypair for this agent
  const keypair = Keypair.generate();
  const id      = uuidv4();
  const apiKey  = `saw_${crypto.randomBytes(24).toString("hex")}`;
  const pubkey  = keypair.publicKey.toBase58();
  saveEncryptedKeypair(walletPathForAgent(id), keypair);

  agentQueries.create.run({
    id,
    name,
    pubkey,
    role,
    api_key: apiKey,
    policy: JSON.stringify(policy),
    heartbeat_interval: heartbeatInterval,
  });

  logEvent("agent_created", { id, name, role, pubkey });

  return {
    id,
    name,
    pubkey,
    role,
    apiKey,
    keypair,  // only returned at creation time — not stored in DB
    signer:   cacheSigner(id, keypair),
  };
}

// ── Load all agents ───────────────────────────────────────────────────────────

export function getAllAgents() {
  return agentQueries.getAll.all().map(row => ({
    ...row,
    policy:    JSON.parse(row.policy || "{}"),
    roleInfo:  AGENT_ROLES[row.role] ?? null,
    isOnline:  row.status === "online" && row.last_seen
               && (Date.now() / 1000 - row.last_seen) < 120, // 2 min timeout
  }));
}

export function getAgent(idOrName) {
  return agentQueries.getById.get(idOrName) ?? agentQueries.getByName.get(idOrName);
}

export function getAgentSigner(idOrName, { autoProvision = true } = {}) {
  const agent = getAgent(idOrName);
  if (!agent) return null;

  const expectedPubkey = agent.pubkey || null;
  const cached = getCachedSigner(agent.id, expectedPubkey);
  if (cached) return cached;

  const encPath = walletPathForAgent(agent.id);
  const existing = loadEncryptedKeypair(encPath);

  if (existing) {
    const loadedPubkey = existing.publicKey.toBase58();
    if (loadedPubkey !== expectedPubkey) {
      agentQueries.updatePubkey.run(loadedPubkey, agent.id);
      logEvent("agent_pubkey_synced", {
        agentId: agent.id,
        previousPubkey: expectedPubkey,
        pubkey: loadedPubkey,
      }, agent.id);
    }
    return cacheSigner(agent.id, existing);
  }

  if (!autoProvision) return null;

  const keypair = Keypair.generate();
  const pubkey = keypair.publicKey.toBase58();
  saveEncryptedKeypair(encPath, keypair);
  agentQueries.updatePubkey.run(pubkey, agent.id);
  logEvent("agent_wallet_provisioned", {
    agentId: agent.id,
    pubkey,
    reason: "wallet_missing",
  }, agent.id);
  return cacheSigner(agent.id, keypair);
}

export function setAgentStatus(id, status) {
  agentQueries.updateStatus.run(status, id);
}

export function heartbeat(id) {
  agentQueries.updateLastSeen.run(id);
}

// ── Default agents (seeded on first run) ──────────────────────────────────────

export function seedDefaultAgents() {
  const defaults = [
    // Original 4 trading agents
    { name: "sable",   role: "trader_bear",   heartbeatInterval: 30  },
    { name: "nova",    role: "trader_bull",   heartbeatInterval: 30  },
    { name: "axiom",   role: "lp_sentinel",   heartbeatInterval: 60  },
    { name: "crest",   role: "yield_farmer",  heartbeatInterval: 120 },

    // 5 new use-case agents
    { name: "pilot",   role: "autopilot",     heartbeatInterval: 60  },
    { name: "harvest", role: "airdrop_farmer",heartbeatInterval: 45  },
    { name: "ledger",  role: "accountant",    heartbeatInterval: 120 },
    { name: "shield",  role: "guardian",      heartbeatInterval: 20  },
    { name: "pay",     role: "social",        heartbeatInterval: 300 },
  ];

  const created = [];
  for (const def of defaults) {
    try {
      const agent = createAgent(def);
      created.push(agent);
      console.log(`[agents] Created: ${def.name} (${def.role}) → ${agent.pubkey}`);
    } catch (e) {
      if (!e.message.includes("already exists")) throw e;
      // Already seeded — skip
    }
  }
  return created;
}
