/**
 * test/sessions.test.js
 *
 * Tests for src/sessions.js:
 *   - issueSession: creates session with correct TTL and scope
 *   - validateSessionForExecution: TTL, skill allowlist, amount cap, destination cap
 *   - revokeSession: marks session inactive
 *   - buildSessionBindingMessage: deterministic hash output
 *
 * No network calls. Uses real SQLite DB (test-isolated via unique scopeSubjects).
 *
 * Run: node --test test/sessions.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  issueSession,
  revokeSession,
  getSessionById,
  validateSessionForExecution,
  buildSessionBindingMessage,
} from "../src/sessions.js";

function uniqueScope() {
  return `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── issueSession ──────────────────────────────────────────────────────────────

describe("issueSession", () => {
  it("creates a session with correct TTL", () => {
    const scope = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 300 });
    assert.ok(session, "Session should be created");
    assert.equal(session.scopeSubject, scope);
    assert.equal(session.ttlSeconds, 300);
    assert.ok(session.active, "Newly issued session must be active");
    const now = Math.floor(Date.now() / 1000);
    assert.ok(session.expiresAt > now, "expiresAt must be in the future");
    assert.ok(session.expiresAt <= now + 305, "expiresAt must be ~now + ttl");
  });

  it("creates a session with skill allowlist", () => {
    const scope = uniqueScope();
    const session = issueSession({
      scopeSubject:  scope,
      allowedSkills: ["transfer_sol", "get_balance"],
      ttlSeconds:    600,
    });
    assert.deepEqual(session.allowedSkills, ["transfer_sol", "get_balance"]);
  });

  it("creates a session with maxPerTxSol cap", () => {
    const scope = uniqueScope();
    const session = issueSession({ scopeSubject: scope, maxPerTxSol: 0.1, ttlSeconds: 300 });
    assert.equal(session.maxPerTxSol, 0.1);
  });

  it("creates a session with destination allowlist", () => {
    const scope = uniqueScope();
    const dest  = "11111111111111111111111111111111";
    const session = issueSession({
      scopeSubject:          scope,
      allowedDestinations:   [dest],
      ttlSeconds:            300,
    });
    assert.deepEqual(session.allowedDestinations, [dest]);
  });

  it("enforces minimum TTL of 60 seconds", () => {
    const scope = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 5 });
    assert.equal(session.ttlSeconds, 60, "TTL should be clamped to 60s minimum");
  });

  it("throws if scopeSubject is missing", () => {
    assert.throws(
      () => issueSession({ ttlSeconds: 300 }),
      /scopeSubject is required/,
    );
  });
});

// ── validateSessionForExecution ───────────────────────────────────────────────

describe("validateSessionForExecution", () => {
  it("allows execution when session has no restrictions", () => {
    const scope   = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 300 });
    const result  = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "get_balance",
      amountSol:    0,
    });
    assert.ok(result.allowed, `Expected allowed=true, got: ${result.reason}`);
  });

  it("blocks when skill is not in allowedSkills", () => {
    const scope   = uniqueScope();
    const session = issueSession({
      scopeSubject:  scope,
      allowedSkills: ["get_balance"],
      ttlSeconds:    300,
    });
    const result = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "transfer_sol",   // not allowed
      amountSol:    0.01,
    });
    assert.ok(!result.allowed, "Should block disallowed skill");
    assert.ok(result.reason.includes("skill_not_allowed"), `Unexpected reason: ${result.reason}`);
  });

  it("allows execution when skill is in allowedSkills", () => {
    const scope   = uniqueScope();
    const session = issueSession({
      scopeSubject:  scope,
      allowedSkills: ["transfer_sol"],
      ttlSeconds:    300,
    });
    const result = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "transfer_sol",
      amountSol:    0.01,
    });
    assert.ok(result.allowed, `Expected allowed=true, got: ${result.reason}`);
  });

  it("blocks when amountSol exceeds maxPerTxSol", () => {
    const scope   = uniqueScope();
    const session = issueSession({
      scopeSubject: scope,
      maxPerTxSol:  0.05,
      ttlSeconds:   300,
    });
    const result = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "transfer_sol",
      amountSol:    0.1,   // exceeds cap
    });
    assert.ok(!result.allowed, "Should block tx exceeding maxPerTxSol");
    assert.ok(result.reason.includes("per_tx_limit"), `Unexpected reason: ${result.reason}`);
  });

  it("allows execution at exactly maxPerTxSol", () => {
    const scope   = uniqueScope();
    const session = issueSession({
      scopeSubject: scope,
      maxPerTxSol:  0.1,
      ttlSeconds:   300,
    });
    const result = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "transfer_sol",
      amountSol:    0.1,   // exactly at cap
    });
    assert.ok(result.allowed, `Expected allowed=true, got: ${result.reason}`);
  });

  it("blocks when destination is not in allowedDestinations", () => {
    const scope   = uniqueScope();
    const allowed = "11111111111111111111111111111111";
    const blocked = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
    const session = issueSession({
      scopeSubject:        scope,
      allowedDestinations: [allowed],
      ttlSeconds:          300,
    });
    const result = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "transfer_sol",
      amountSol:    0.01,
      destination:  blocked,
    });
    assert.ok(!result.allowed, "Should block unlisted destination");
    assert.ok(result.reason.includes("destination_not_allowed"), `Unexpected reason: ${result.reason}`);
  });

  it("blocks when session scopeSubject does not match caller", () => {
    const scope   = uniqueScope();
    const other   = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 300 });
    const result  = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: other,   // wrong agent
      skillName:    "get_balance",
    });
    assert.ok(!result.allowed, "Should block scope mismatch");
    assert.ok(result.reason.includes("scope_mismatch"), `Unexpected reason: ${result.reason}`);
  });

  it("blocks when session is revoked", () => {
    const scope   = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 300 });
    revokeSession(session.id, "test_revoke");
    const result  = validateSessionForExecution({
      sessionId:    session.id,
      scopeSubject: scope,
      skillName:    "get_balance",
    });
    assert.ok(!result.allowed, "Should block revoked session");
    assert.ok(
      result.reason.includes("invalid_or_expired") || result.reason.includes("session_id"),
      `Unexpected reason: ${result.reason}`,
    );
  });

  it("returns allowed=false for unknown sessionId", () => {
    const result = validateSessionForExecution({
      sessionId:    "00000000-0000-0000-0000-000000000000",
      scopeSubject: "any-agent",
      skillName:    "get_balance",
    });
    assert.ok(!result.allowed, "Unknown session must be rejected");
  });
});

// ── revokeSession ─────────────────────────────────────────────────────────────

describe("revokeSession", () => {
  it("marks session as inactive after revocation", () => {
    const scope   = uniqueScope();
    const session = issueSession({ scopeSubject: scope, ttlSeconds: 300 });
    assert.ok(session.active, "Session should be active before revocation");
    revokeSession(session.id, "test");
    const fetched = getSessionById(session.id);
    assert.ok(!fetched.active, "Session should be inactive after revocation");
    assert.ok(fetched.revokedAt, "revokedAt should be set");
    assert.equal(fetched.revokeReason, "test");
  });
});

// ── buildSessionBindingMessage ────────────────────────────────────────────────

describe("buildSessionBindingMessage", () => {
  it("produces a deterministic message", () => {
    const params = { toAddress: "11111111111111111111111111111111", amountSol: 0.01 };
    const a = buildSessionBindingMessage({
      sessionId:      "sess-123",
      scopeSubject:   "nova",
      skillName:      "transfer_sol",
      params,
      idempotencyKey: "idem-abc",
    });
    const b = buildSessionBindingMessage({
      sessionId:      "sess-123",
      scopeSubject:   "nova",
      skillName:      "transfer_sol",
      params,
      idempotencyKey: "idem-abc",
    });
    assert.equal(a.message, b.message, "Same inputs must produce same message");
    assert.equal(a.messageHash, b.messageHash);
  });

  it("produces different messages for different idempotency keys", () => {
    const base = { sessionId: "s1", scopeSubject: "nova", skillName: "transfer_sol", params: {} };
    const a = buildSessionBindingMessage({ ...base, idempotencyKey: "key-1" });
    const b = buildSessionBindingMessage({ ...base, idempotencyKey: "key-2" });
    assert.notEqual(a.message, b.message);
  });

  it("includes skill name in message", () => {
    const msg = buildSessionBindingMessage({
      sessionId: "s1", scopeSubject: "nova", skillName: "jupiter_swap",
    });
    assert.ok(msg.message.includes("jupiter_swap"), "Message must contain skill name");
  });
});
