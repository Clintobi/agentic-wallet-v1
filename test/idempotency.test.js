/**
 * test/idempotency.test.js
 *
 * Tests for src/idempotency.js:
 *   - checkIdempotency: returns hit=false for unknown keys, hit=true after record
 *   - recordIdempotency: stores result retrievable by checkIdempotency
 *   - Duplicate execution prevention (same key → cached result)
 *   - pruneIdempotencyCache: runs without throwing
 *   - generateIdempotencyKey: different inputs produce different keys
 *   - IDEMPOTENT_SKILLS set contains expected value-moving skills
 *
 * Uses real SQLite DB. Each test uses a unique key to avoid cross-contamination.
 *
 * Run: node --test test/idempotency.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkIdempotency,
  recordIdempotency,
  generateIdempotencyKey,
  pruneIdempotencyCache,
  IDEMPOTENT_SKILLS,
} from "../src/idempotency.js";

function uniqueKey() {
  return `test-idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── checkIdempotency ──────────────────────────────────────────────────────────

describe("checkIdempotency", () => {
  it("returns hit=false for unknown key", () => {
    const result = checkIdempotency(uniqueKey(), "agent-1", "transfer_sol");
    assert.equal(result.hit, false);
    assert.equal(result.result, undefined);
  });

  it("returns hit=false when key is null", () => {
    const result = checkIdempotency(null, "agent-1", "transfer_sol");
    assert.equal(result.hit, false);
  });

  it("returns hit=false when key is empty string", () => {
    const result = checkIdempotency("", "agent-1", "transfer_sol");
    assert.equal(result.hit, false);
  });

  it("returns cached result after record", () => {
    const key    = uniqueKey();
    const agentId = "agent-cache-test";
    const skill  = "transfer_sol";
    const payload = { sig: "abc123", confirmed: true, amountSol: 0.01 };

    recordIdempotency(key, agentId, skill, payload);

    const result = checkIdempotency(key, agentId, skill);
    assert.equal(result.hit, true);
    assert.deepEqual(result.result, payload);
    assert.ok(result.cachedAt, "cachedAt must be present");
  });
});

// ── recordIdempotency ─────────────────────────────────────────────────────────

describe("recordIdempotency", () => {
  it("stores result without throwing", () => {
    assert.doesNotThrow(() => {
      recordIdempotency(uniqueKey(), "agent-1", "transfer_sol", { sig: "xyz", confirmed: true });
    });
  });

  it("handles null key gracefully (no-op)", () => {
    assert.doesNotThrow(() => {
      recordIdempotency(null, "agent-1", "transfer_sol", { sig: "xyz" });
    });
  });

  it("stores complex result objects", () => {
    const key = uniqueKey();
    const payload = {
      sig:           "4xBCKLmn9...",
      confirmed:     true,
      amountSol:     0.05,
      firewall:      { riskScore: 10, allowed: true },
      feeStrategy:   { priorityFeeLamports: 5000, protectionMode: "standard_rpc" },
    };
    recordIdempotency(key, "complex-agent", "jupiter_swap", payload);
    const result = checkIdempotency(key, "complex-agent", "jupiter_swap");
    assert.ok(result.hit);
    assert.deepEqual(result.result.firewall, payload.firewall);
    assert.deepEqual(result.result.feeStrategy, payload.feeStrategy);
  });

  it("key is agent+skill scoped (same key, different agent = miss)", () => {
    const key = uniqueKey();
    recordIdempotency(key, "agent-A", "transfer_sol", { sig: "sig-A" });

    // Different agent should NOT hit agent-A's cached result
    const miss = checkIdempotency(key, "agent-B", "transfer_sol");
    assert.equal(miss.hit, false, "Different agent must not hit another agent's cache");
  });

  it("key is agent+skill scoped (same key, different skill = miss)", () => {
    const key = uniqueKey();
    recordIdempotency(key, "agent-A", "transfer_sol", { sig: "sig-sol" });

    const miss = checkIdempotency(key, "agent-A", "transfer_usdc");
    assert.equal(miss.hit, false, "Different skill must not hit a different skill's cache");
  });

  it("second record with same key overwrites first (upsert)", () => {
    const key    = uniqueKey();
    const agentId = "upsert-agent";
    const skill  = "marinade_stake";

    recordIdempotency(key, agentId, skill, { staked: true, epoch: 1 });
    recordIdempotency(key, agentId, skill, { staked: true, epoch: 2 }); // overwrite

    const result = checkIdempotency(key, agentId, skill);
    assert.ok(result.hit);
    assert.equal(result.result.epoch, 2, "Second record should overwrite first");
  });
});

// ── pruneIdempotencyCache ─────────────────────────────────────────────────────

describe("pruneIdempotencyCache", () => {
  it("runs without throwing and returns a number", () => {
    const deleted = pruneIdempotencyCache();
    assert.ok(typeof deleted === "number", `Expected number, got ${typeof deleted}`);
    assert.ok(deleted >= 0);
  });
});

// ── generateIdempotencyKey ────────────────────────────────────────────────────

describe("generateIdempotencyKey", () => {
  it("returns a non-empty string", () => {
    const key = generateIdempotencyKey("transfer_sol", { amountSol: 0.01 }, "agent-1");
    assert.ok(typeof key === "string");
    assert.ok(key.length > 0);
  });

  it("same inputs in same minute produce same key", () => {
    const skill  = "transfer_sol";
    const params = { amountSol: 0.01, toAddress: "abc" };
    const agent  = "agent-gen";
    const a = generateIdempotencyKey(skill, params, agent);
    const b = generateIdempotencyKey(skill, params, agent);
    assert.equal(a, b, "Same inputs same minute must produce same key");
  });

  it("different skills produce different keys", () => {
    const params = { amountSol: 0.01 };
    const agent  = "agent-gen";
    const a = generateIdempotencyKey("transfer_sol",  params, agent);
    const b = generateIdempotencyKey("transfer_usdc", params, agent);
    assert.notEqual(a, b);
  });

  it("different agents produce different keys", () => {
    const key1 = generateIdempotencyKey("transfer_sol", { amountSol: 0.01 }, "agent-A");
    const key2 = generateIdempotencyKey("transfer_sol", { amountSol: 0.01 }, "agent-B");
    assert.notEqual(key1, key2);
  });
});

// ── IDEMPOTENT_SKILLS set ─────────────────────────────────────────────────────

describe("IDEMPOTENT_SKILLS", () => {
  it("includes core value-moving skills", () => {
    const required = ["transfer_sol", "transfer_usdc", "jupiter_swap", "marinade_stake", "marinade_unstake"];
    for (const skill of required) {
      assert.ok(IDEMPOTENT_SKILLS.has(skill), `IDEMPOTENT_SKILLS must include: ${skill}`);
    }
  });

  it("does not include read-only skills", () => {
    const readOnly = ["get_balance", "get_sol_price", "get_stake_rate"];
    for (const skill of readOnly) {
      assert.ok(!IDEMPOTENT_SKILLS.has(skill), `IDEMPOTENT_SKILLS must NOT include read-only: ${skill}`);
    }
  });
});
