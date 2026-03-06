/**
 * src/policy.js
 *
 * Policy engine — evaluates every proposed action before signing.
 * All checks run in-order; first failure stops evaluation.
 *
 * Default policy loaded from policy.json.
 * Policy is hot-reloadable: POST /api/policy on the dashboard server.
 *
 * Checks (in order):
 *   0. emergency_pause      — global kill switch, blocks ALL execution immediately
 *   1. agent_frozen         — per-agent freeze triggered by velocity guard or manual
 *   2. agent_scope          — agent may only call skills in its allowedScopes list
 *   3. reserve_floor        — treasury must keep ≥ reserveSol after the action
 *   4. per_tx_limit         — single action ≤ maxPerTxSol
 *   5. daily_limit          — rolling 24h total ≤ dailyLimitSol
 *   6. program_allowlist    — called programs must be in allowedPrograms (or list empty = allow all)
 *   7. destination_allowlist — recipients must be in allowedDestinations (or empty = allow all)
 *   8. cooldown             — minimum seconds between actions per agent
 *   9. human_approval_gate  — actions above approvalThresholdSol need human sign-off
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(__dir, "../policy.json");

// Rolling 24h spend tracker per agent
const dailySpend  = {}; // agentId -> [{ amount, ts }]
const lastTxTime  = {}; // agentId -> timestamp ms
// Per-minute velocity tracker
const minuteSpend = {}; // agentId -> [{ amount, ts }]
// Pending approvals: agentId -> { resolve, reject, action }
const pendingApprovals = {};

// ── Emergency pause controls ──────────────────────────────────────────────────

export function pauseAll(reason = "manual") {
  const p = getPolicy();
  _policy = { ...p, emergencyPause: true, pausedAt: Date.now(), pauseReason: reason };
  console.log(`[policy] 🚨 EMERGENCY PAUSE ACTIVATED — reason: ${reason}`);
}

export function resumeAll() {
  const p = getPolicy();
  _policy = { ...p, emergencyPause: false, pausedAt: null, pauseReason: null };
  console.log(`[policy] ✅ Emergency pause lifted — all agents resumed`);
}

export function isPaused() {
  return !!getPolicy().emergencyPause;
}

// ── Agent freeze controls ─────────────────────────────────────────────────────

export function freezeAgent(agentId, reason = "velocity_limit") {
  const p = getPolicy();
  const frozen = new Set(p.frozenAgents || []);
  frozen.add(agentId);
  _policy = { ...p, frozenAgents: [...frozen] };
  console.log(`[policy] ❄️  Agent ${agentId} FROZEN — reason: ${reason}`);
}

export function unfreezeAgent(agentId) {
  const p = getPolicy();
  const frozen = (p.frozenAgents || []).filter(id => id !== agentId);
  _policy = { ...p, frozenAgents: frozen };
  console.log(`[policy] 🔓 Agent ${agentId} unfrozen`);
}

export function isAgentFrozen(agentId) {
  return (getPolicy().frozenAgents || []).includes(agentId);
}

export function getFrozenAgents() {
  return getPolicy().frozenAgents || [];
}

function get24hSpend(agentId) {
  const now    = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  dailySpend[agentId] = (dailySpend[agentId] || []).filter(e => e.ts > cutoff);
  return dailySpend[agentId].reduce((s, e) => s + e.amount, 0);
}

function getMinuteSpend(agentId) {
  const now    = Date.now();
  const cutoff = now - 60 * 1000; // rolling 1-minute window
  minuteSpend[agentId] = (minuteSpend[agentId] || []).filter(e => e.ts > cutoff);
  return minuteSpend[agentId].reduce((s, e) => s + e.amount, 0);
}

function recordSpend(agentId, amount) {
  if (!dailySpend[agentId])  dailySpend[agentId]  = [];
  if (!minuteSpend[agentId]) minuteSpend[agentId] = [];
  const entry = { amount, ts: Date.now() };
  dailySpend[agentId].push(entry);
  minuteSpend[agentId].push(entry);
  lastTxTime[agentId] = Date.now();
}

// ── Policy loader ─────────────────────────────────────────────────────────────

let _policy = null;

export function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  _policy = JSON.parse(fs.readFileSync(policyPath, "utf-8"));
  return _policy;
}

export function getPolicy() {
  if (!_policy) loadPolicy();
  return _policy;
}

export function updatePolicy(partial) {
  _policy = { ...getPolicy(), ...partial };
}

// ── Core evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate whether an action is permitted by the current policy.
 *
 * @param {object} opts
 * @param {string} opts.agentId            - unique agent identifier
 * @param {number} opts.amountSol          - SOL equivalent value of the action
 * @param {number} opts.currentBalanceSol  - current wallet balance before action
 * @param {string} [opts.destination]      - recipient address (if applicable)
 * @param {string[]} [opts.programs]       - program IDs invoked by the action
 * @param {string} [opts.skill]            - skill name being requested (for scope check)
 * @param {string} [opts.scopeSubject]     - stable scope key (usually agent name); falls back to agentId
 * @returns {{ allowed: boolean, reason: string, requiresApproval?: boolean }}
 */
export function evaluate({ agentId, amountSol, currentBalanceSol, destination = null, programs = [], skill = null, scopeSubject = null }) {
  const p = getPolicy();
  const scopeKey = scopeSubject || agentId;

  // 0. Emergency pause — global kill switch
  if (p.emergencyPause) {
    return { allowed: false, reason: `emergency_pause: ${p.pauseReason || "manual"}`, paused: true };
  }

  // 1. Agent frozen (velocity auto-freeze or manual freeze)
  if ((p.frozenAgents || []).includes(agentId)) {
    return { allowed: false, reason: `agent_frozen: ${agentId}`, frozen: true };
  }

  // 2. Agent scope check — ensure agent is allowed to call this skill
  if (skill && p.agentScopes && p.agentScopes[scopeKey]) {
    const allowedSkills = p.agentScopes[scopeKey];
    if (allowedSkills.length > 0 && !allowedSkills.includes(skill)) {
      return { allowed: false, reason: `scope_violation: subject=${scopeKey} skill=${skill} not_in_scope` };
    }
  }

  // 3. Reserve floor
  const balanceAfter = currentBalanceSol - amountSol;
  if (balanceAfter < p.reserveSol) {
    return { allowed: false, reason: `reserve_floor: balance_after=${balanceAfter.toFixed(4)}<reserve=${p.reserveSol}` };
  }

  // 4. Per-transaction limit
  if (amountSol > p.maxPerTxSol) {
    return { allowed: false, reason: `per_tx_limit: ${amountSol}>${p.maxPerTxSol}` };
  }

  // 5. Daily rolling limit
  const spent = get24hSpend(agentId);
  if (spent + amountSol > p.dailyLimitSol) {
    return { allowed: false, reason: `daily_limit: spent=${spent.toFixed(4)}+${amountSol}>${p.dailyLimitSol}` };
  }

  // 5a. Per-minute velocity guard — auto-freeze if exceeded
  const velocityLimit = p.velocityFreezeSol ?? 0;
  if (velocityLimit > 0 && amountSol > 0) {
    const minuteSpent = getMinuteSpend(agentId);
    if (minuteSpent + amountSol > velocityLimit) {
      freezeAgent(agentId, `velocity_limit: ${(minuteSpent + amountSol).toFixed(4)}>${velocityLimit} SOL/min`);
      return { allowed: false, reason: `velocity_freeze: agent=${agentId} spend=${(minuteSpent + amountSol).toFixed(4)}>${velocityLimit}SOL/min`, frozen: true };
    }
  }

  // 6. Program allowlist
  if (p.allowedPrograms && p.allowedPrograms.length > 0) {
    const blocked = programs.filter(prog => !p.allowedPrograms.includes(prog));
    if (blocked.length > 0) {
      return { allowed: false, reason: `program_allowlist: unauthorized=${blocked[0]}` };
    }
  }

  // 7. Destination allowlist
  if (p.allowedDestinations && p.allowedDestinations.length > 0 && destination) {
    if (!p.allowedDestinations.includes(destination)) {
      return { allowed: false, reason: `destination_allowlist: ${destination} not allowed` };
    }
  }

  // 8. Cooldown
  const last = lastTxTime[agentId] || 0;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed < p.cooldownSeconds) {
    return { allowed: false, reason: `cooldown: ${elapsed.toFixed(1)}s<${p.cooldownSeconds}s` };
  }

  // 9. Human approval gate
  if (amountSol >= p.approvalThresholdSol) {
    return { allowed: false, reason: `human_approval_required: ${amountSol}>=${p.approvalThresholdSol}`, requiresApproval: true };
  }

  // All checks passed — record the spend
  recordSpend(agentId, amountSol);
  return { allowed: true, reason: "ok" };
}

// ── Human approval flow ───────────────────────────────────────────────────────

export function requestApproval(agentId, action) {
  return new Promise((resolve, reject) => {
    pendingApprovals[agentId] = { resolve, reject, action, requestedAt: Date.now() };
    console.log(`[policy] ⏸  Human approval requested for ${agentId}: ${JSON.stringify(action)}`);
  });
}

export function approveAction(agentId) {
  if (!pendingApprovals[agentId]) throw new Error(`No pending approval for ${agentId}`);
  pendingApprovals[agentId].resolve(true);
  delete pendingApprovals[agentId];
}

export function rejectAction(agentId) {
  if (!pendingApprovals[agentId]) throw new Error(`No pending approval for ${agentId}`);
  pendingApprovals[agentId].reject(new Error("Human rejected action"));
  delete pendingApprovals[agentId];
}

export function getPendingApprovals() {
  return Object.entries(pendingApprovals).map(([agentId, v]) => ({
    agentId, action: v.action, requestedAt: v.requestedAt
  }));
}
