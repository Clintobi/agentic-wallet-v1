/**
 * src/db.js
 *
 * SQLite persistent state — agents, transactions, daily spend, events,
 * autopilot rules, protocol activity, balance snapshots, alerts, payment requests.
 * Survives server restarts. Uses better-sqlite3 (synchronous, no async overhead).
 *
 * Tables:
 *   agents            — named agent identities + config
 *   transactions      — every tx executed with full metadata
 *   spend_log         — rolling spend tracker for policy engine
 *   events            — webhook events, payment notifications, heartbeats
 *   autopilot_rules   — user-defined conditional automation rules
 *   protocol_activity — airdrop farmer: tracks last-touch per protocol per agent
 *   balance_snapshots — accountant: periodic SOL balance readings for yield calc
 *   alerts            — guardian: price / balance anomaly alerts
 *   payment_requests  — social wallet: Solana Pay payment requests
 *   skill_idempotency — dedupe/replay cache for idempotent skill execution
 *   agent_sessions    — owner-issued, revocable scoped sessions for agents
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dir, "../data/wallet.db");

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    pubkey      TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'trader',
    status      TEXT NOT NULL DEFAULT 'offline',
    api_key     TEXT UNIQUE NOT NULL,
    policy      TEXT NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen   INTEGER,
    heartbeat_interval INTEGER DEFAULT 30,
    total_txs   INTEGER DEFAULT 0,
    total_sol_sent REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    skill       TEXT NOT NULL,
    status      TEXT NOT NULL,
    sig         TEXT,
    amount_sol  REAL DEFAULT 0,
    token       TEXT DEFAULT 'SOL',
    from_addr   TEXT,
    to_addr     TEXT,
    protocol    TEXT,
    details     TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    confirmed_at INTEGER,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS spend_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    agent_id   TEXT,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS autopilot_rules (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    condition   TEXT NOT NULL,
    action      TEXT NOT NULL,
    params      TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_fired  INTEGER,
    fire_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS protocol_activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    action      TEXT NOT NULL,
    result      TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS balance_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    balance_sol REAL NOT NULL,
    sol_price   REAL,
    balance_usd REAL,
    note        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'info',
    message     TEXT NOT NULL,
    data        TEXT,
    acked       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS payment_requests (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    label       TEXT NOT NULL,
    memo        TEXT,
    amount_sol  REAL,
    recipient   TEXT NOT NULL,
    reference   TEXT UNIQUE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    paid_sig    TEXT,
    paid_at     INTEGER,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS skill_idempotency (
    key_hash    TEXT PRIMARY KEY,
    key_text    TEXT NOT NULL,
    skill       TEXT NOT NULL,
    result      TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS agent_sessions (
    id                   TEXT PRIMARY KEY,
    scope_subject        TEXT NOT NULL,
    owner_id             TEXT NOT NULL DEFAULT 'owner',
    session_pubkey       TEXT,
    allowed_skills       TEXT NOT NULL DEFAULT '[]',
    allowed_programs     TEXT NOT NULL DEFAULT '[]',
    allowed_destinations TEXT NOT NULL DEFAULT '[]',
    max_per_tx_sol       REAL,
    ttl_seconds          INTEGER NOT NULL,
    expires_at           INTEGER NOT NULL,
    revoked_at           INTEGER,
    revoke_reason        TEXT,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_txs_agent        ON transactions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_txs_created      ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spend_agent      ON spend_log(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_type      ON events(type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_agent      ON autopilot_rules(agent_id);
  CREATE INDEX IF NOT EXISTS idx_proto_agent      ON protocol_activity(agent_id, protocol);
  CREATE INDEX IF NOT EXISTS idx_snaps_agent      ON balance_snapshots(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_agent     ON alerts(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payreq_ref       ON payment_requests(reference);
  CREATE INDEX IF NOT EXISTS idx_payreq_status    ON payment_requests(status);
  CREATE INDEX IF NOT EXISTS idx_idempotency_exp  ON skill_idempotency(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_scope   ON agent_sessions(scope_subject, expires_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_active  ON agent_sessions(expires_at, revoked_at);
`);

// ── Agents ────────────────────────────────────────────────────────────────────

export const agentQueries = {
  create: db.prepare(`
    INSERT INTO agents (id, name, pubkey, role, api_key, policy, heartbeat_interval)
    VALUES (@id, @name, @pubkey, @role, @api_key, @policy, @heartbeat_interval)
  `),
  getAll: db.prepare(`SELECT * FROM agents ORDER BY created_at DESC`),
  getById: db.prepare(`SELECT * FROM agents WHERE id = ?`),
  getByName: db.prepare(`SELECT * FROM agents WHERE name = ?`),
  getByApiKey: db.prepare(`SELECT * FROM agents WHERE api_key = ?`),
  updateStatus: db.prepare(`UPDATE agents SET status = ?, last_seen = unixepoch() WHERE id = ?`),
  updateLastSeen: db.prepare(`UPDATE agents SET last_seen = unixepoch() WHERE id = ?`),
  incrementTxCount: db.prepare(`UPDATE agents SET total_txs = total_txs + 1, total_sol_sent = total_sol_sent + ? WHERE id = ?`),
  updatePolicy: db.prepare(`UPDATE agents SET policy = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM agents WHERE id = ?`),
};

// ── Transactions ──────────────────────────────────────────────────────────────

export const txQueries = {
  insert: db.prepare(`
    INSERT INTO transactions (id, agent_id, skill, status, sig, amount_sol, token, from_addr, to_addr, protocol, details, error)
    VALUES (@id, @agent_id, @skill, @status, @sig, @amount_sol, @token, @from_addr, @to_addr, @protocol, @details, @error)
  `),
  confirm: db.prepare(`UPDATE transactions SET status = 'confirmed', confirmed_at = unixepoch() WHERE id = ?`),
  fail: db.prepare(`UPDATE transactions SET status = 'failed', error = ? WHERE id = ?`),
  getById: db.prepare(`SELECT * FROM transactions WHERE id = ?`),
  getRecent: db.prepare(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?`),
  getByAgent: db.prepare(`SELECT * FROM transactions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`),
  getByStatus: db.prepare(`SELECT * FROM transactions WHERE status = ? ORDER BY created_at DESC LIMIT 50`),
};

// ── Spend log ─────────────────────────────────────────────────────────────────

export const spendQueries = {
  record: db.prepare(`INSERT INTO spend_log (agent_id, amount_sol) VALUES (?, ?)`),
  get24h: db.prepare(`
    SELECT COALESCE(SUM(amount_sol), 0) as total
    FROM spend_log
    WHERE agent_id = ? AND created_at > unixepoch() - 86400
  `),
  getLastTx: db.prepare(`
    SELECT MAX(created_at) as last_ts FROM spend_log WHERE agent_id = ?
  `),
};

// ── Events ────────────────────────────────────────────────────────────────────

export const eventQueries = {
  insert: db.prepare(`INSERT INTO events (type, agent_id, data) VALUES (?, ?, ?)`),
  getRecent: db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`),
  getByType: db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY created_at DESC LIMIT 50`),
};

// ── Autopilot rules ───────────────────────────────────────────────────────────

export const ruleQueries = {
  insert: db.prepare(`
    INSERT INTO autopilot_rules (id, agent_id, name, condition, action, params)
    VALUES (@id, @agent_id, @name, @condition, @action, @params)
  `),
  getByAgent: db.prepare(`SELECT * FROM autopilot_rules WHERE agent_id = ? ORDER BY created_at DESC`),
  getActive: db.prepare(`SELECT * FROM autopilot_rules WHERE enabled = 1 ORDER BY created_at ASC`),
  updateFired: db.prepare(`UPDATE autopilot_rules SET last_fired = unixepoch(), fire_count = fire_count + 1 WHERE id = ?`),
  setEnabled: db.prepare(`UPDATE autopilot_rules SET enabled = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM autopilot_rules WHERE id = ?`),
  getAll: db.prepare(`SELECT * FROM autopilot_rules ORDER BY created_at DESC`),
};

// ── Protocol activity ─────────────────────────────────────────────────────────

export const protoQueries = {
  insert: db.prepare(`
    INSERT INTO protocol_activity (agent_id, protocol, action, result)
    VALUES (?, ?, ?, ?)
  `),
  getByAgent: db.prepare(`SELECT * FROM protocol_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`),
  getLastTouch: db.prepare(`
    SELECT protocol, MAX(created_at) as last_ts
    FROM protocol_activity
    WHERE agent_id = ?
    GROUP BY protocol
  `),
  getRecent: db.prepare(`SELECT * FROM protocol_activity ORDER BY created_at DESC LIMIT ?`),
};

// ── Balance snapshots ─────────────────────────────────────────────────────────

export const snapQueries = {
  insert: db.prepare(`
    INSERT INTO balance_snapshots (agent_id, balance_sol, sol_price, balance_usd, note)
    VALUES (?, ?, ?, ?, ?)
  `),
  getByAgent: db.prepare(`SELECT * FROM balance_snapshots WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`),
  getRecent: db.prepare(`SELECT * FROM balance_snapshots ORDER BY created_at DESC LIMIT ?`),
  getFirst: db.prepare(`SELECT * FROM balance_snapshots WHERE agent_id = ? ORDER BY created_at ASC LIMIT 1`),
  getLast: db.prepare(`SELECT * FROM balance_snapshots WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`),
  getSince: db.prepare(`
    SELECT * FROM balance_snapshots
    WHERE agent_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `),
};

// ── Alerts ────────────────────────────────────────────────────────────────────

export const alertQueries = {
  insert: db.prepare(`
    INSERT INTO alerts (agent_id, type, severity, message, data)
    VALUES (?, ?, ?, ?, ?)
  `),
  getByAgent: db.prepare(`SELECT * FROM alerts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`),
  getUnacked: db.prepare(`SELECT * FROM alerts WHERE acked = 0 ORDER BY created_at DESC`),
  getRecent: db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`),
  ack: db.prepare(`UPDATE alerts SET acked = 1 WHERE id = ?`),
  ackAll: db.prepare(`UPDATE alerts SET acked = 1 WHERE agent_id = ?`),
};

// ── Payment requests ──────────────────────────────────────────────────────────

export const payReqQueries = {
  insert: db.prepare(`
    INSERT INTO payment_requests (id, agent_id, label, memo, amount_sol, recipient, reference, status)
    VALUES (@id, @agent_id, @label, @memo, @amount_sol, @recipient, @reference, @status)
  `),
  getAll: db.prepare(`SELECT * FROM payment_requests ORDER BY created_at DESC`),
  getByAgent: db.prepare(`SELECT * FROM payment_requests WHERE agent_id = ? ORDER BY created_at DESC`),
  getByRef: db.prepare(`SELECT * FROM payment_requests WHERE reference = ?`),
  getById: db.prepare(`SELECT * FROM payment_requests WHERE id = ?`),
  markPaid: db.prepare(`UPDATE payment_requests SET status = 'paid', paid_sig = ?, paid_at = unixepoch() WHERE id = ?`),
  cancel: db.prepare(`UPDATE payment_requests SET status = 'cancelled' WHERE id = ?`),
};

// ── Skill idempotency cache ───────────────────────────────────────────────────

export const idempotencyQueries = {
  getActive: db.prepare(`
    SELECT * FROM skill_idempotency
    WHERE key_hash = ? AND expires_at > unixepoch()
    LIMIT 1
  `),
  upsert: db.prepare(`
    INSERT INTO skill_idempotency (key_hash, key_text, skill, result, expires_at)
    VALUES (@key_hash, @key_text, @skill, @result, @expires_at)
    ON CONFLICT(key_hash) DO UPDATE SET
      key_text   = excluded.key_text,
      skill      = excluded.skill,
      result     = excluded.result,
      expires_at = excluded.expires_at,
      created_at = unixepoch()
  `),
  deleteExpired: db.prepare(`DELETE FROM skill_idempotency WHERE expires_at <= unixepoch()`),
};

// ── Agent scoped sessions ─────────────────────────────────────────────────────

export const sessionQueries = {
  issue: db.prepare(`
    INSERT INTO agent_sessions (
      id, scope_subject, owner_id, session_pubkey,
      allowed_skills, allowed_programs, allowed_destinations,
      max_per_tx_sol, ttl_seconds, expires_at
    ) VALUES (
      @id, @scope_subject, @owner_id, @session_pubkey,
      @allowed_skills, @allowed_programs, @allowed_destinations,
      @max_per_tx_sol, @ttl_seconds, @expires_at
    )
  `),
  getById: db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`),
  getActiveById: db.prepare(`
    SELECT * FROM agent_sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > unixepoch()
    LIMIT 1
  `),
  listRecent: db.prepare(`
    SELECT * FROM agent_sessions
    ORDER BY created_at DESC
    LIMIT ?
  `),
  listByScope: db.prepare(`
    SELECT * FROM agent_sessions
    WHERE scope_subject = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
  listActive: db.prepare(`
    SELECT * FROM agent_sessions
    WHERE revoked_at IS NULL AND expires_at > unixepoch()
    ORDER BY created_at DESC
    LIMIT ?
  `),
  revoke: db.prepare(`
    UPDATE agent_sessions
    SET revoked_at = unixepoch(), revoke_reason = ?
    WHERE id = ? AND revoked_at IS NULL
  `),
  deleteExpiredRevoked: db.prepare(`
    DELETE FROM agent_sessions
    WHERE (revoked_at IS NOT NULL AND revoked_at <= unixepoch() - 86400)
       OR expires_at <= unixepoch() - 86400
  `),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function logEvent(type, data, agentId = null) {
  eventQueries.insert.run(type, agentId, JSON.stringify(data));
}

export function recordTx({ id, agentId, skill, status = "pending", sig = null,
  amountSol = 0, token = "SOL", fromAddr = null, toAddr = null,
  protocol = null, details = null, error = null }) {
  txQueries.insert.run({
    id, agent_id: agentId, skill, status, sig,
    amount_sol: amountSol, token, from_addr: fromAddr,
    to_addr: toAddr, protocol, details: details ? JSON.stringify(details) : null, error,
  });
}

export function get24hSpend(agentId) {
  return spendQueries.get24h.get(agentId)?.total ?? 0;
}

export function getLastTxTime(agentId) {
  return spendQueries.getLastTx.get(agentId)?.last_ts ?? 0;
}

// Convenience: insert a guardian alert
export function insertAlert({ agentId, type, severity = "info", message, data = null }) {
  alertQueries.insert.run(agentId, type, severity, message, data ? JSON.stringify(data) : null);
}

// initDb is a no-op (schema runs at import time) — exported for explicit boot signalling
export function initDb() {
  // Schema already applied above at module load time.
  // Called from server.js to make the boot sequence explicit.
}

export default db;
