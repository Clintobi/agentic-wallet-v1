/**
 * dashboard/server.js
 *
 * Production dashboard server — the nerve center of the agentic wallet.
 *
 * Wires together:
 *   - HeartbeatEngine      — autonomous agent poll cycle (runs forever)
 *   - SQLite DB            — persistent agent state, TX history, events
 *   - Gasless TX layer     — Kora + treasury sponsor
 *   - Solana Actions/Blinks — fundable via Phantom/Dialect
 *   - Helius webhooks      — real-time on-chain event detection
 *   - SSE broadcast        — live dashboard updates
 *   - REST API             — agent management, skill execution, policy
 *   - Autopilot            — IF/THEN rule engine
 *   - Guardian             — security monitoring + alerts
 *   - Accountant           — balance snapshots + yield tracking
 *   - Airdrop Farmer       — protocol activity scheduler
 *   - Social Wallet        — Solana Pay payment requests
 *
 * Start:
 *   WALLET_PASSPHRASE=contest2025 PORT=3000 node dashboard/server.js
 */

import "dotenv/config";
import path    from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createServer } from "http";
import { v4 as uuidv4 } from "uuid";

// ── src modules ───────────────────────────────────────────────────────────────

// Skills must be imported first so registry is populated
import "../src/skills/balance.js";
import "../src/skills/transfer.js";
import "../src/skills/jupiter.js";
import "../src/skills/marginfi.js";
import "../src/skills/marinade.js";
import "../src/skills/guardian.js";
import "../src/skills/accountant.js";
import "../src/skills/autopilot.js";
import "../src/skills/airdrop_farmer.js";
import "../src/skills/social.js";

import { execute, listSkills }                       from "../src/skills/registry.js";
import { getSimulatedPrice }                          from "../src/skills/guardian.js";
import { loadPolicy, getPolicy, updatePolicy,
         approveAction, rejectAction,
         getPendingApprovals,
         pauseAll, resumeAll, isPaused,
         freezeAgent, unfreezeAgent,
         isAgentFrozen, getFrozenAgents }             from "../src/policy.js";
import { loadOrCreateKeypair, createKeypairSigner }  from "../src/signing/keypairSigner.js";
import { getBalanceSol, getAllBalances }              from "../src/wallet.js";
import { PORT }                                      from "../src/config.js";

import { initDb, agentQueries, txQueries,
         logEvent, get24hSpend,
         ruleQueries, protoQueries, snapQueries,
         alertQueries, payReqQueries, insertAlert,
         recordTx }                                   from "../src/db.js";
import { getAllAgents, getAgent, createAgent,
         setAgentStatus, seedDefaultAgents,
         AGENT_ROLES }                                from "../src/agents.js";
import { HeartbeatEngine }                           from "../src/heartbeat.js";
import { handleHeliusWebhook }                       from "../src/webhooks.js";
import { issueSession, listSessions,
         revokeSession, getSessionById,
         buildSessionBindingMessage }                 from "../src/sessions.js";
import {
  actionsHeaders, handleOptions,
  getActionMeta, postActionFund,
  postActionFundAgent
}                                                    from "../src/actions.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadPolicy(path.join(__dir, "../policy.json"));
initDb(); // create tables if not exists

const walletPath = path.join(__dir, "../wallet.enc.json");
const keypair    = loadOrCreateKeypair(walletPath);
const signer     = createKeypairSigner(keypair);
const treasury   = signer.publicKey.toBase58();

// Seed default agents if none exist
seedDefaultAgents();

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── Heartbeat engine ──────────────────────────────────────────────────────────

const engine = new HeartbeatEngine({ treasurySigner: signer, broadcast });
engine.start();

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dir, "public")));

function classifyTxStatus(result = {}) {
  if (result?.ok === false && result?.blocked) return "blocked";
  if (result?.sig) return "confirmed";
  if (result?.ok === false) return "failed";

  const reason = String(result?.reason || result?.error || "").toLowerCase();
  const note = String(result?.note || "").toLowerCase();
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

const TX_ACTIVITY_SKILLS = new Set([
  "transfer_sol",
  "transfer_usdc",
  "jupiter_swap",
  "marginfi_deposit",
  "marginfi_borrow",
  "marginfi_withdraw",
  "marginfi_repay",
  "marinade_stake",
  "marinade_unstake",
]);

function shouldRecordSkillExecution({ skill, result, amountSol }) {
  if (result?.sig) return true;
  if (TX_ACTIVITY_SKILLS.has(skill)) return true;
  if (amountSol > 0 && (result?.ok === false || result?.blocked)) return true;
  return false;
}

async function withTimeout(promise, ms, fallback = null) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  sseClients.add(res);

  // Send initial state
  Promise.all([
    withTimeout(getBalanceSol(treasury).catch(() => null), 4000, null),
    getAllAgents(),
  ]).then(([sol, agents]) => {
    res.write(`event: init\ndata: ${JSON.stringify({
      treasury, sol, agents,
      skills:  listSkills().map(s => s.name),
      policy:  getPolicy(),
      network: process.env.SOLANA_NETWORK || "devnet",
    })}\n\n`);
  }).catch(() => {});

  req.on("close", () => sseClients.delete(res));
});

// ── Wallet state ──────────────────────────────────────────────────────────────

app.get("/api/state", async (req, res) => {
  try {
    const [sol, agents] = await Promise.all([
      withTimeout(getBalanceSol(treasury).catch(() => null), 4000, null),
      getAllAgents(),
    ]);
    const txs = txQueries.getRecent.all(50);

    res.json({
      ok:       true,
      treasury,
      network:  process.env.SOLANA_NETWORK || "devnet",
      sol,
      solPrice: getSimulatedPrice(),
      agents,
      agentRoles: AGENT_ROLES,
      txs,
      skills:   listSkills().map(s => s.name),
      policy:   getPolicy(),
      pendingApprovals: getPendingApprovals(),
      paused:   isPaused(),
      frozenAgents: getFrozenAgents(),
      liveSwapEnabled: (process.env.SOLANA_NETWORK || "devnet") === "mainnet-beta",
      recentOnchainTxs: txs.filter(tx => !!tx.sig).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Skills list (full objects with descriptions) ──────────────────────────────

app.get("/api/skills", (_req, res) => {
  res.json({ ok: true, skills: listSkills() });
});

// ── Agent management ──────────────────────────────────────────────────────────

// GET /api/agents — list all agents
app.get("/api/agents", (_req, res) => {
  res.json({ ok: true, agents: getAllAgents(), roles: AGENT_ROLES });
});

// GET /api/agents/:id — single agent + recent txs
app.get("/api/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ ok: false, error: "Agent not found" });
  const txs = txQueries.getByAgent.all(agent.id, 20);
  res.json({ ok: true, agent, txs });
});

// POST /api/agents — create new agent
app.post("/api/agents", (req, res) => {
  try {
    const { name, role, heartbeatInterval, policy } = req.body;
    const agent = createAgent({ name, role, heartbeatInterval, policy });
    engine.startAgent({ ...agent, heartbeat_interval: heartbeatInterval || 30 });
    broadcast("agent_created", { agent });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/agents/:id/stop — stop agent heartbeat
app.post("/api/agents/:id/stop", (req, res) => {
  engine.stopAgent(req.params.id);
  res.json({ ok: true });
});

// POST /api/agents/:id/start — restart agent heartbeat
app.post("/api/agents/:id/start", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ ok: false, error: "Agent not found" });
  engine._startAgent(agent);
  res.json({ ok: true });
});

// ── Skill execution ───────────────────────────────────────────────────────────

app.post("/api/skill", async (req, res) => {
  const { skill, params, agentId } = req.body ?? {};
  if (!skill) return res.status(400).json({ ok: false, error: "skill required" });

  const resolvedAgentId = agentId || "dashboard";
  const idempotencyKey = req.get("x-idempotency-key")
    || req.body?.idempotencyKey
    || null;
  const sessionId = req.get("x-session-id")
    || req.body?.sessionId
    || null;
  const sessionProof = req.get("x-session-proof")
    || req.body?.sessionProof
    || null;
  const agent = getAgent(resolvedAgentId);
  const context = {
    signer,
    agentId: resolvedAgentId,
    agentName: agent?.name || null,
    agentRole: agent?.role || null,
    idempotencyKey,
    sessionId,
    sessionProof,
  };
  try {
    const txId = uuidv4();
    const result = await execute(skill, params ?? {}, context);
    const status = classifyTxStatus(result);
    const amountSol = Number(params?.amountSol ?? 0) || 0;
    const toAddr = params?.toAddress
      || params?.destination
      || params?.recipient
      || result?.toAddress
      || result?.destination
      || result?.recipient
      || null;

    if (shouldRecordSkillExecution({ skill, result, amountSol })) {
      recordTx({
        id: txId,
        agentId: resolvedAgentId,
        skill,
        status,
        sig: result?.sig || null,
        amountSol,
        token: params?.token || "SOL",
        fromAddr: signer.publicKey.toBase58(),
        toAddr,
        details: result,
        error: result?.reason || result?.error || null,
      });
    }

    broadcast("skill_result", { txId, skill, params, status, result, ts: Date.now() });
    res.json({ ...result, txId, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/quote — quote-only helper (never recorded in tx history)
app.post("/api/quote", async (req, res) => {
  try {
    const params = req.body ?? {};
    const result = await execute("get_quote", params, {
      signer,
      agentId: "dashboard",
      agentName: "dashboard",
      agentRole: null,
      idempotencyKey: null,
      sessionId: null,
      sessionProof: null,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, available: false, reason: "quote_api_error", error: e.message });
  }
});

// ── Transaction history ───────────────────────────────────────────────────────

app.get("/api/txs", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const txs   = txQueries.getRecent.all(limit);
  res.json({ ok: true, txs });
});

app.get("/api/txs/:agentId", (req, res) => {
  const txs = txQueries.getByAgent.all(req.params.agentId, 50);
  res.json({ ok: true, txs });
});

function toIsoFromUnix(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

function parseJsonSafe(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function explorerUrl(sig) {
  if (!sig) return null;
  const cluster = process.env.SOLANA_NETWORK === "mainnet-beta" ? "" : "?cluster=devnet";
  return `https://solscan.io/tx/${sig}${cluster}`;
}

function buildReceipt(tx) {
  const details = parseJsonSafe(tx.details);
  const destination = tx.to_addr
    || details?.toAddress
    || details?.recipient
    || details?.destination
    || null;
  const firewall = details?.firewall || null;
  const session = details?.session || null;
  const sessionBinding = details?.sessionBinding || null;
  const protectionMode = details?.protectionMode
    || details?.feeStrategy?.protectionMode
    || null;
  const feeStrategy = details?.feeStrategy || null;

  const policyReason = details?.reason || details?.error || tx.error || null;
  const amount = tx.amount_sol ?? details?.amountSol ?? details?.amountUsdc ?? 0;

  return {
    txId: tx.id,
    status: tx.status,
    agentId: tx.agent_id,
    skill: tx.skill,
    amount,
    token: tx.token || "SOL",
    from: tx.from_addr || null,
    to: destination,
    signature: tx.sig || null,
    explorer: explorerUrl(tx.sig),
    reason: policyReason,
    protectionMode,
    feeStrategy,
    firewall,
    riskScore: firewall?.riskScore ?? null,
    riskLevel: firewall?.riskLevel ?? null,
    firewallDecision: firewall ? (firewall.blocked ? "blocked" : "allowed") : null,
    firewallReason: firewall?.reasons?.[0] ?? null,
    session,
    sessionBinding,
    createdAt: toIsoFromUnix(tx.created_at),
    confirmedAt: toIsoFromUnix(tx.confirmed_at),
    details,
  };
}

// GET /api/txs/:txId/receipt - shareable JSON receipt
app.get("/api/txs/:txId/receipt", (req, res) => {
  const tx = txQueries.getById.get(req.params.txId);
  if (!tx) return res.status(404).json({ ok: false, error: "Transaction not found" });
  res.json({ ok: true, receipt: buildReceipt(tx) });
});

// GET /api/txs/:txId/receipt.html - shareable HTML receipt
app.get("/api/txs/:txId/receipt.html", (req, res) => {
  const tx = txQueries.getById.get(req.params.txId);
  if (!tx) return res.status(404).send("Transaction not found");

  const r = buildReceipt(tx);
  const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Spend Receipt ${esc(r.txId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 24px; color: #111827; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .meta { color: #4b5563; margin-bottom: 18px; }
    .box { border: 1px solid #d1d5db; border-radius: 10px; padding: 14px; max-width: 760px; }
    .row { display: grid; grid-template-columns: 180px 1fr; padding: 6px 0; border-bottom: 1px solid #f3f4f6; }
    .row:last-child { border-bottom: 0; }
    .key { color: #6b7280; }
    .val { word-break: break-word; }
    a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Spend Receipt</h1>
  <div class="meta">Generated by Solana Agent Wallet dashboard</div>
  <div class="box">
    <div class="row"><div class="key">Transaction ID</div><div class="val">${esc(r.txId)}</div></div>
    <div class="row"><div class="key">Status</div><div class="val">${esc(r.status)}</div></div>
    <div class="row"><div class="key">Agent</div><div class="val">${esc(r.agentId)}</div></div>
    <div class="row"><div class="key">Skill</div><div class="val">${esc(r.skill)}</div></div>
    <div class="row"><div class="key">Amount</div><div class="val">${esc(r.amount)} ${esc(r.token)}</div></div>
    <div class="row"><div class="key">From</div><div class="val">${esc(r.from)}</div></div>
    <div class="row"><div class="key">To</div><div class="val">${esc(r.to)}</div></div>
    <div class="row"><div class="key">Reason / Note</div><div class="val">${esc(r.reason)}</div></div>
    <div class="row"><div class="key">Protection Mode</div><div class="val">${esc(r.protectionMode)}</div></div>
    <div class="row"><div class="key">Firewall</div><div class="val">${esc(r.firewallDecision)}${r.riskScore != null ? ` · score=${esc(r.riskScore)} (${esc(r.riskLevel)})` : ""}${r.firewallReason ? ` · ${esc(r.firewallReason)}` : ""}</div></div>
    <div class="row"><div class="key">Session Scope</div><div class="val">${esc(r.session?.id || "")}${r.session?.scopeSubject ? ` · ${esc(r.session.scopeSubject)}` : ""}${r.session?.expiresAt ? ` · exp=${esc(new Date(r.session.expiresAt * 1000).toISOString())}` : ""}</div></div>
    <div class="row"><div class="key">Session Signature</div><div class="val">${r.sessionBinding ? esc(r.sessionBinding.verified ? "verified" : "invalid") : ""}</div></div>
    <div class="row"><div class="key">Priority Fee</div><div class="val">${esc(r.feeStrategy?.priorityFeeLamports ?? "")}</div></div>
    <div class="row"><div class="key">Created At</div><div class="val">${esc(r.createdAt)}</div></div>
    <div class="row"><div class="key">Confirmed At</div><div class="val">${esc(r.confirmedAt)}</div></div>
    <div class="row"><div class="key">Signature</div><div class="val">${esc(r.signature)}</div></div>
    <div class="row"><div class="key">Explorer</div><div class="val">${r.explorer ? `<a href="${esc(r.explorer)}" target="_blank" rel="noreferrer">${esc(r.explorer)}</a>` : ""}</div></div>
  </div>
</body>
</html>`);
});

// ── Policy management ─────────────────────────────────────────────────────────

app.get("/api/policy",  (_req, res) => res.json(getPolicy()));
app.post("/api/policy", (req, res) => {
  updatePolicy(req.body);
  broadcast("policy_update", getPolicy());
  logEvent("policy_updated", req.body, "dashboard");
  res.json({ ok: true, policy: getPolicy() });
});

// ── Session scopes (owner-issued, revocable) ─────────────────────────────────

app.get("/api/sessions", (req, res) => {
  const scopeSubject = req.query.scopeSubject ? String(req.query.scopeSubject) : null;
  const activeOnly = String(req.query.active || "0") === "1";
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const sessions = listSessions({ scopeSubject, activeOnly, limit });
  res.json({ ok: true, sessions });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
  res.json({ ok: true, session });
});

app.post("/api/sessions", (req, res) => {
  try {
    const {
      scopeSubject,
      ownerId,
      sessionPubkey,
      ttlSeconds,
      maxPerTxSol,
      allowedSkills,
      allowedPrograms,
      allowedDestinations,
    } = req.body ?? {};

    const session = issueSession({
      scopeSubject,
      ownerId: ownerId || "dashboard_owner",
      sessionPubkey: sessionPubkey || null,
      ttlSeconds: ttlSeconds ?? 3600,
      maxPerTxSol: maxPerTxSol ?? null,
      allowedSkills: Array.isArray(allowedSkills) ? allowedSkills : [],
      allowedPrograms: Array.isArray(allowedPrograms) ? allowedPrograms : [],
      allowedDestinations: Array.isArray(allowedDestinations) ? allowedDestinations : [],
    });

    broadcast("session_issued", { session, ts: Date.now() });
    logEvent("session_issued", session, "dashboard");
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Deterministic message to sign with session private key (Ed25519)
app.post("/api/sessions/:id/binding", (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
  const skillName = req.body?.skillName || req.body?.skill || null;
  const params = req.body?.params || {};
  const idempotencyKey = req.body?.idempotencyKey || null;
  if (!skillName) return res.status(400).json({ ok: false, error: "skillName required" });
  const payload = buildSessionBindingMessage({
    sessionId: session.id,
    scopeSubject: session.scopeSubject,
    skillName,
    params,
    idempotencyKey,
  });
  res.json({ ok: true, binding: payload, sessionId: session.id, scopeSubject: session.scopeSubject, sessionPubkey: session.sessionPubkey });
});

app.post("/api/sessions/:id/revoke", (req, res) => {
  try {
    const reason = req.body?.reason || "manual";
    const session = revokeSession(req.params.id, reason);
    broadcast("session_revoked", { sessionId: req.params.id, reason, ts: Date.now() });
    logEvent("session_revoked", { sessionId: req.params.id, reason }, "dashboard");
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Emergency pause / kill switch ─────────────────────────────────────────────

// POST /api/pause — halt ALL agent execution immediately
app.post("/api/pause", (req, res) => {
  const { reason } = req.body ?? {};
  pauseAll(reason || "manual");
  broadcast("emergency_pause", { paused: true, reason: reason || "manual", ts: Date.now() });
  logEvent("emergency_pause", { reason }, "dashboard");
  res.json({ ok: true, paused: true, reason: reason || "manual" });
});

// POST /api/resume — lift emergency pause
app.post("/api/resume", (req, res) => {
  resumeAll();
  broadcast("emergency_resume", { paused: false, ts: Date.now() });
  logEvent("emergency_resume", {}, "dashboard");
  res.json({ ok: true, paused: false });
});

// GET /api/pause — pause status
app.get("/api/pause", (_req, res) => {
  const p = getPolicy();
  res.json({
    ok:     true,
    paused: !!p.emergencyPause,
    reason: p.pauseReason ?? null,
    pausedAt: p.pausedAt ?? null,
    frozenAgents: p.frozenAgents ?? [],
  });
});

// POST /api/freeze/:agentId — freeze a single agent
app.post("/api/freeze/:agentId", (req, res) => {
  const { reason } = req.body ?? {};
  freezeAgent(req.params.agentId, reason || "manual");
  broadcast("agent_frozen", { agentId: req.params.agentId, reason: reason || "manual", ts: Date.now() });
  logEvent("agent_frozen", { agentId: req.params.agentId, reason }, "dashboard");
  res.json({ ok: true, agentId: req.params.agentId, frozen: true });
});

// POST /api/unfreeze/:agentId — unfreeze a single agent
app.post("/api/unfreeze/:agentId", (req, res) => {
  unfreezeAgent(req.params.agentId);
  broadcast("agent_unfrozen", { agentId: req.params.agentId, ts: Date.now() });
  logEvent("agent_unfrozen", { agentId: req.params.agentId }, "dashboard");
  res.json({ ok: true, agentId: req.params.agentId, frozen: false });
});

// GET /api/frozen — list all frozen agents
app.get("/api/frozen", (_req, res) => {
  res.json({ ok: true, frozenAgents: getFrozenAgents() });
});

// ── Human approval flow ───────────────────────────────────────────────────────

app.post("/api/approve/:agentId", (req, res) => {
  try {
    approveAction(req.params.agentId);
    broadcast("action_approved", { agentId: req.params.agentId });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

app.post("/api/reject/:agentId", (req, res) => {
  try {
    rejectAction(req.params.agentId);
    broadcast("action_rejected", { agentId: req.params.agentId });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

// ── Autopilot rules ───────────────────────────────────────────────────────────

// GET /api/rules — all rules or by agent
app.get("/api/rules", (req, res) => {
  const { agentId } = req.query;
  const rules = agentId
    ? ruleQueries.getByAgent.all(agentId)
    : ruleQueries.getAll.all();
  res.json({ ok: true, rules });
});

// POST /api/rules — create rule
app.post("/api/rules", async (req, res) => {
  try {
    const result = await execute("autopilot_create_rule", req.body, { signer, agentId: "dashboard" });
    if (result.ok) broadcast("rule_created", { rule: result.rule });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// DELETE /api/rules/:id — delete rule
app.delete("/api/rules/:id", async (req, res) => {
  try {
    const result = await execute("autopilot_delete_rule", { ruleId: req.params.id }, { signer, agentId: "dashboard" });
    if (result.ok) broadcast("rule_deleted", { ruleId: req.params.id });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// PATCH /api/rules/:id/toggle — enable/disable
app.patch("/api/rules/:id/toggle", (req, res) => {
  const { enabled } = req.body;
  ruleQueries.setEnabled.run(enabled ? 1 : 0, req.params.id);
  broadcast("rule_toggled", { ruleId: req.params.id, enabled: !!enabled });
  res.json({ ok: true, ruleId: req.params.id, enabled: !!enabled });
});

// ── Guardian alerts ───────────────────────────────────────────────────────────

// GET /api/alerts — recent alerts
app.get("/api/alerts", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const alerts = alertQueries.getRecent.all(limit).map(r => ({
    ...r,
    data: r.data ? JSON.parse(r.data) : null,
  }));
  res.json({ ok: true, alerts });
});

// GET /api/alerts/unacked — unacknowledged alerts only
app.get("/api/alerts/unacked", (_req, res) => {
  const alerts = alertQueries.getUnacked.all().map(r => ({
    ...r,
    data: r.data ? JSON.parse(r.data) : null,
  }));
  res.json({ ok: true, alerts, count: alerts.length });
});

// POST /api/alerts/:id/ack — acknowledge one alert
app.post("/api/alerts/:id/ack", (req, res) => {
  alertQueries.ack.run(req.params.id);
  broadcast("alert_acked", { alertId: req.params.id });
  res.json({ ok: true });
});

// POST /api/alerts/ack-all — acknowledge all for an agent
app.post("/api/alerts/ack-all", (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ ok: false, error: "agentId required" });
  alertQueries.ackAll.run(agentId);
  broadcast("alerts_acked", { agentId });
  res.json({ ok: true });
});

// ── Accountant snapshots & yield ─────────────────────────────────────────────

// GET /api/snapshots — recent balance snapshots
app.get("/api/snapshots", (req, res) => {
  const limit  = Math.min(Number(req.query.limit || 50), 200);
  const { agentId } = req.query;
  const snaps = agentId
    ? snapQueries.getByAgent.all(agentId, limit)
    : snapQueries.getRecent.all(limit);
  res.json({ ok: true, snaps });
});

// GET /api/snapshots/:agentId/yield — yield summary for an agent
app.get("/api/snapshots/:agentId/yield", async (req, res) => {
  try {
    const result = await execute("get_yield_summary",
      { agentId: req.params.agentId, limit: 100 },
      { signer, agentId: "dashboard" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Airdrop farmer activity ───────────────────────────────────────────────────

// GET /api/farmer/:agentId/status — last-touch per protocol
app.get("/api/farmer/:agentId/status", async (req, res) => {
  try {
    const result = await execute("get_farmer_status",
      { agentId: req.params.agentId },
      { signer, agentId: "dashboard" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/farmer/:agentId/activity — full activity log
app.get("/api/farmer/:agentId/activity", async (req, res) => {
  try {
    const result = await execute("get_farmer_activity",
      { agentId: req.params.agentId, limit: 50 },
      { signer, agentId: "dashboard" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Social wallet — payment requests ─────────────────────────────────────────

// GET /api/payments — all payment requests
app.get("/api/payments", (req, res) => {
  const { agentId, status } = req.query;
  let rows = agentId
    ? payReqQueries.getByAgent.all(agentId)
    : payReqQueries.getAll.all();
  if (status) rows = rows.filter(r => r.status === status);
  res.json({ ok: true, requests: rows });
});

// POST /api/payments — create payment request
app.post("/api/payments", async (req, res) => {
  try {
    const result = await execute("create_payment_request", req.body, { signer, agentId: req.body.agentId || "dashboard" });
    if (result.ok) broadcast("payment_request_created", result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// DELETE /api/payments/:id — cancel payment request
app.delete("/api/payments/:id", async (req, res) => {
  try {
    const result = await execute("cancel_payment_request",
      { payReqId: req.params.id }, { signer, agentId: "dashboard" });
    if (result.ok) broadcast("payment_request_cancelled", { payReqId: req.params.id });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/payments/:id — get single payment request
app.get("/api/payments/:id", (req, res) => {
  const req2 = payReqQueries.getById.get(req.params.id);
  if (!req2) return res.status(404).json({ ok: false, error: "Payment request not found" });
  res.json({ ok: true, request: req2 });
});

// ── Solana Actions / Blinks ───────────────────────────────────────────────────

app.options("/actions/*", handleOptions);

app.get ("/actions/fund",             (req, res) => getActionMeta(req, res, treasury));
app.post("/actions/fund",             (req, res) => postActionFund(req, res, treasury));
app.post("/actions/fund-agent/:name", postActionFundAgent);

// Solana Actions for payment requests
app.get("/actions/pay/:payReqId", (req, res) => {
  const payReq = payReqQueries.getById.get(req.params.payReqId);
  if (!payReq) return res.status(404).json({ error: "Payment request not found" });

  res.set(actionsHeaders);
  res.json({
    icon:        `${process.env.BLINK_BASE_URL || "http://localhost:3000"}/logo.png`,
    title:       payReq.label,
    description: payReq.memo || `Pay ${payReq.amount_sol ? payReq.amount_sol + " SOL" : "any amount"}`,
    label:       "Pay Now",
    links: {
      actions: [{
        label:  `Pay ${payReq.amount_sol ? payReq.amount_sol + " SOL" : ""}`,
        href:   `/actions/pay/${payReq.id}`,
      }],
    },
  });
});

app.post("/actions/pay/:payReqId", (req, res) => {
  const payReq = payReqQueries.getById.get(req.params.payReqId);
  if (!payReq) return res.status(404).json({ error: "Payment request not found" });

  // Return the Solana Pay transaction spec (wallet builds the tx)
  res.set(actionsHeaders);
  res.json({
    transaction: null, // Solana Pay handles this natively via solanaPay URL
    message:     `Payment of ${payReq.amount_sol || "?"} SOL to ${payReq.label}`,
    redirect:    `solana:${payReq.recipient}?amount=${payReq.amount_sol}&label=${encodeURIComponent(payReq.label)}&reference=${payReq.reference}`,
  });
});

// ── Helius Webhook ────────────────────────────────────────────────────────────

app.post("/webhook/helius", (req, res) => {
  handleHeliusWebhook(req, res, {
    broadcast,
    onPayment: (payment) => {
      logEvent("incoming_payment", payment, payment.agentId || "treasury");

      // Check if payment matches a pending payment request (via reference)
      if (payment.signature) {
        const allPending = payReqQueries.getAll.all().filter(r => r.status === "pending");
        for (const pr of allPending) {
          // Real impl: check if reference account was in the tx accounts
          // Demo: just log the match
          logEvent("payment_request_match_check", { payReqId: pr.id, sig: payment.signature });
        }
      }
    },
  });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  const agents  = getAllAgents();
  const unacked = alertQueries.getUnacked.all().length;
  res.json({
    ok:           true,
    uptime:       process.uptime(),
    agents:       agents.filter(a => a.isOnline).length,
    totalAgents:  agents.length,
    unackedAlerts: unacked,
    network:      process.env.SOLANA_NETWORK || "devnet",
    ts:           Date.now(),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = createServer(app);

server.listen(PORT, () => {
  const agents  = getAllAgents();
  const online  = agents.filter(a => a.isOnline).length;

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║          Solana Agent Wallet — Dashboard             ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  URL      : http://localhost:${PORT}                    ║`);
  console.log(`║  Treasury : ${treasury.slice(0,20)}...   ║`);
  console.log(`║  Network  : ${(process.env.SOLANA_NETWORK || "devnet").padEnd(42)} ║`);
  console.log(`║  Agents   : ${String(agents.length).padEnd(42)} ║`);
  console.log(`║  Skills   : ${listSkills().map(s=>s.name).join(", ").slice(0,42).padEnd(42)} ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
});

// Graceful shutdown
process.on("SIGINT",  () => { engine.stop(); server.close(); process.exit(0); });
process.on("SIGTERM", () => { engine.stop(); server.close(); process.exit(0); });
