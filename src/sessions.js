/**
 * src/sessions.js
 *
 * Owner-issued, revocable scoped sessions for agent execution.
 * Session scopes can constrain:
 *   - scope subject (agent name / id)
 *   - allowed skills
 *   - allowed destinations
 *   - allowed programs
 *   - per-tx SOL amount ceiling
 *   - TTL / expiry
 */

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import bs58 from "bs58";
import { sessionQueries } from "./db.js";

function parseList(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (!raw) return [];
  try {
    const out = JSON.parse(raw);
    return Array.isArray(out) ? out.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function normalizeSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeSubject: row.scope_subject,
    ownerId: row.owner_id,
    sessionPubkey: row.session_pubkey || null,
    allowedSkills: parseList(row.allowed_skills),
    allowedPrograms: parseList(row.allowed_programs),
    allowedDestinations: parseList(row.allowed_destinations),
    maxPerTxSol: row.max_per_tx_sol == null ? null : Number(row.max_per_tx_sol),
    ttlSeconds: Number(row.ttl_seconds),
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    revokeReason: row.revoke_reason || null,
    createdAt: Number(row.created_at),
    active: row.revoked_at == null && Number(row.expires_at) > Math.floor(Date.now() / 1000),
  };
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function toUnixSecondsFromNow(ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return now + ttlSeconds;
}

function sessionVerifyPublicKey(pubkeyBase58) {
  const raw = bs58.decode(pubkeyBase58);
  if (raw.length !== 32) throw new Error("invalid_session_pubkey");
  // RFC8410 SPKI wrapper for Ed25519 raw 32-byte public key.
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([prefix, Buffer.from(raw)]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

function decodeSessionProof(proof) {
  if (!proof) return null;
  const str = String(proof).trim();
  if (!str) return null;
  if (/^[A-Za-z0-9+/=]+$/.test(str) && str.length % 4 === 0) {
    try { return Buffer.from(str, "base64"); } catch {}
  }
  try { return Buffer.from(bs58.decode(str)); } catch {}
  return null;
}

function hashHex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function buildSessionBindingMessage({
  sessionId,
  scopeSubject,
  skillName,
  params = {},
  idempotencyKey = null,
}) {
  const stable = stableStringify(params ?? {});
  const paramsHash = hashHex(stable);
  const idem = idempotencyKey || "none";
  const message = `solana-agent-wallet:session-bind:v1:${sessionId}:${scopeSubject}:${skillName}:${idem}:${paramsHash}`;
  return { message, paramsHash, messageHash: hashHex(message) };
}

function verifySessionBindingProof({ sessionPubkey, message, sessionProof }) {
  const signature = decodeSessionProof(sessionProof);
  if (!signature) return false;
  try {
    const key = sessionVerifyPublicKey(sessionPubkey);
    return crypto.verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function issueSession({
  scopeSubject,
  ownerId = "dashboard",
  sessionPubkey = null,
  allowedSkills = [],
  allowedPrograms = [],
  allowedDestinations = [],
  maxPerTxSol = null,
  ttlSeconds = 3600,
}) {
  if (!scopeSubject) throw new Error("scopeSubject is required");
  if (sessionPubkey) sessionVerifyPublicKey(sessionPubkey); // validate upfront
  const ttl = Math.max(60, Math.floor(Number(ttlSeconds) || 0));
  const id = uuidv4();
  const expiresAt = toUnixSecondsFromNow(ttl);

  sessionQueries.issue.run({
    id,
    scope_subject: scopeSubject,
    owner_id: ownerId,
    session_pubkey: sessionPubkey,
    allowed_skills: JSON.stringify([...new Set(allowedSkills.map(String))]),
    allowed_programs: JSON.stringify([...new Set(allowedPrograms.map(String))]),
    allowed_destinations: JSON.stringify([...new Set(allowedDestinations.map(String))]),
    max_per_tx_sol: Number.isFinite(Number(maxPerTxSol)) ? Number(maxPerTxSol) : null,
    ttl_seconds: ttl,
    expires_at: expiresAt,
  });

  return getSessionById(id);
}

export function revokeSession(sessionId, reason = "manual") {
  if (!sessionId) throw new Error("sessionId is required");
  sessionQueries.revoke.run(reason, sessionId);
  return getSessionById(sessionId);
}

export function getSessionById(sessionId) {
  return normalizeSessionRow(sessionQueries.getById.get(sessionId));
}

export function listSessions({ scopeSubject = null, activeOnly = false, limit = 100 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 100, 500));
  let rows;
  if (activeOnly) rows = sessionQueries.listActive.all(n);
  else if (scopeSubject) rows = sessionQueries.listByScope.all(scopeSubject, n);
  else rows = sessionQueries.listRecent.all(n);
  return rows.map(normalizeSessionRow);
}

export function validateSessionForExecution({
  sessionId,
  scopeSubject,
  skillName,
  amountSol = 0,
  destination = null,
  programs = [],
  params = {},
  idempotencyKey = null,
  sessionProof = null,
  requireBindingProof = true,
}) {
  if (!sessionId) return { allowed: false, reason: "session_required" };
  const row = sessionQueries.getActiveById.get(sessionId);
  if (!row) return { allowed: false, reason: `session_invalid_or_expired:${sessionId}` };

  const session = normalizeSessionRow(row);
  if (!session) return { allowed: false, reason: `session_invalid_or_expired:${sessionId}` };

  if (scopeSubject && session.scopeSubject !== scopeSubject) {
    return {
      allowed: false,
      reason: `session_scope_mismatch:${scopeSubject}!=${session.scopeSubject}`,
      session,
    };
  }

  if (session.allowedSkills.length > 0 && !session.allowedSkills.includes(skillName)) {
    return {
      allowed: false,
      reason: `session_skill_not_allowed:${skillName}`,
      session,
    };
  }

  if (session.maxPerTxSol != null && Number(amountSol) > session.maxPerTxSol) {
    return {
      allowed: false,
      reason: `session_per_tx_limit:${amountSol}>${session.maxPerTxSol}`,
      session,
    };
  }

  if (destination && session.allowedDestinations.length > 0 && !session.allowedDestinations.includes(destination)) {
    return {
      allowed: false,
      reason: `session_destination_not_allowed:${destination}`,
      session,
    };
  }

  if (programs.length > 0 && session.allowedPrograms.length > 0) {
    const blocked = programs.filter(p => !session.allowedPrograms.includes(p));
    if (blocked.length > 0) {
      return {
        allowed: false,
        reason: `session_program_not_allowed:${blocked[0]}`,
        session,
      };
    }
  }

  let binding = null;
  if (session.sessionPubkey && requireBindingProof) {
    if (!idempotencyKey) {
      return {
        allowed: false,
        reason: "session_binding_missing_idempotency",
        session,
      };
    }
    const payload = buildSessionBindingMessage({
      sessionId,
      scopeSubject: session.scopeSubject,
      skillName,
      params,
      idempotencyKey,
    });
    const verified = verifySessionBindingProof({
      sessionPubkey: session.sessionPubkey,
      message: payload.message,
      sessionProof,
    });
    if (!sessionProof) {
      return {
        allowed: false,
        reason: "session_signature_required",
        session,
        binding: { ...payload, verified: false },
      };
    }
    if (!verified) {
      return {
        allowed: false,
        reason: "session_signature_invalid",
        session,
        binding: { ...payload, verified: false },
      };
    }
    binding = {
      ...payload,
      verified: true,
      sessionPubkey: session.sessionPubkey,
    };
  }

  return { allowed: true, reason: "ok", session, binding };
}
