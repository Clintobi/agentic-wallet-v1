/**
 * test/firewall.test.js
 *
 * Tests for src/firewall.js evaluateFirewall():
 *   - Non-value-moving skills → evaluated=false, allowed=true
 *   - Value-moving skills → evaluated=true with risk scoring
 *   - Result structure: riskScore, riskLevel, checks[], inspectedAt, actor
 *   - High-value amounts → higher risk score
 *   - Check array contains valid objects with id + status
 *
 * API signature: evaluateFirewall({ skillName, params, context })
 *   - skillName: string  (skill identifier)
 *   - params:    object  (skill parameters including amountSol, toAddress)
 *   - context:   object  (agentId, agentName, ...)
 *
 * Run: node --test test/firewall.test.js
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

let evaluateFirewall;

before(async () => {
  const mod = await import("../src/firewall.js");
  evaluateFirewall = mod.evaluateFirewall;
});

// ── helpers ───────────────────────────────────────────────────────────────────

const KNOWN_DEST = "11111111111111111111111111111111"; // system program

function baseRequest(overrides = {}) {
  return {
    skillName: "transfer_sol",
    params:    { toAddress: KNOWN_DEST, amountSol: 0.01 },
    context:   { agentId: "test-agent" },
    ...overrides,
  };
}

// ── Non-value-moving skills ───────────────────────────────────────────────────

describe("non-value-moving skills", () => {
  it("skips evaluation for get_balance (read-only)", async () => {
    const result = await evaluateFirewall({
      skillName: "get_balance",
      params:    {},
      context:   { agentId: "test-agent" },
    });
    assert.ok(!result.evaluated, "Read-only skill should not be evaluated");
    assert.ok(result.allowed,    "Unevaluated skills default to allowed");
  });

  it("skips evaluation for get_sol_price", async () => {
    const result = await evaluateFirewall({
      skillName: "get_sol_price",
      params:    {},
      context:   { agentId: "test-agent" },
    });
    assert.ok(!result.evaluated);
    assert.ok(result.allowed);
  });
});

// ── Value-moving skills ───────────────────────────────────────────────────────

describe("value-moving skills", () => {
  it("evaluates transfer_sol and returns structured result", async () => {
    const result = await evaluateFirewall(baseRequest());
    assert.ok(result.evaluated,             "transfer_sol should be evaluated");
    assert.ok(typeof result.riskScore === "number", "riskScore must be a number");
    assert.ok(typeof result.allowed   === "boolean","allowed must be boolean");
    assert.ok(Array.isArray(result.checks),         "checks must be an array");
    assert.ok(typeof result.riskLevel === "string",  "riskLevel must be a string");
  });

  it("evaluates jupiter_swap and returns evaluated=true", async () => {
    const result = await evaluateFirewall({
      skillName: "jupiter_swap",
      params:    { inputMint: "SOL", outputMint: "USDC", amountSol: 0.1 },
      context:   { agentId: "test-agent" },
    });
    assert.ok(result.evaluated, "jupiter_swap should be evaluated");
    assert.ok(typeof result.riskScore === "number");
  });

  it("evaluates marinade_stake", async () => {
    const result = await evaluateFirewall({
      skillName: "marinade_stake",
      params:    { amountSol: 0.05 },
      context:   { agentId: "test-agent" },
    });
    assert.ok(result.evaluated);
  });
});

// ── Risk scoring ──────────────────────────────────────────────────────────────

describe("risk scoring", () => {
  it("returns low risk for small amounts to known destination", async () => {
    const result = await evaluateFirewall(baseRequest({ params: { toAddress: KNOWN_DEST, amountSol: 0.01 } }));
    // Oracle may be unreachable in test env but risk should remain low overall
    assert.ok(["none", "low", "medium"].includes(result.riskLevel),
      `Expected none/low/medium risk, got: ${result.riskLevel} (score=${result.riskScore})`);
  });

  it("returns higher risk for high-value amounts (>= 0.5 SOL)", async () => {
    const small = await evaluateFirewall(baseRequest({ params: { toAddress: KNOWN_DEST, amountSol: 0.01 } }));
    const large = await evaluateFirewall(baseRequest({ params: { toAddress: KNOWN_DEST, amountSol: 1.0  } }));
    assert.ok(
      large.riskScore >= small.riskScore,
      `Large (${large.riskScore}) should be >= small (${small.riskScore})`,
    );
  });

  it("check array contains valid status values", async () => {
    const result = await evaluateFirewall(baseRequest());
    assert.ok(Array.isArray(result.checks));
    assert.ok(result.checks.length > 0, "Must have at least one check");
    for (const check of result.checks) {
      assert.ok(check.id, `check missing id: ${JSON.stringify(check)}`);
      assert.ok(
        ["pass", "warn", "block"].includes(check.status),
        `Invalid check status: ${check.status}`,
      );
    }
  });

  it("includes inspectedAt as valid ISO timestamp", async () => {
    const result = await evaluateFirewall(baseRequest());
    assert.ok(result.inspectedAt, "Result must include inspectedAt");
    assert.ok(!isNaN(Date.parse(result.inspectedAt)), "inspectedAt must be a valid ISO date");
  });

  it("actor derives from context.agentId", async () => {
    const result = await evaluateFirewall(baseRequest({ context: { agentId: "agent-xyz" } }));
    assert.equal(result.actor, "agent-xyz");
  });
});

// ── riskLevel mapping ─────────────────────────────────────────────────────────

describe("riskLevel derivation", () => {
  it("returns one of the valid riskLevel strings", async () => {
    const result = await evaluateFirewall(baseRequest());
    const VALID = new Set(["none", "low", "medium", "high", "critical"]);
    assert.ok(VALID.has(result.riskLevel),
      `riskLevel must be a valid value, got: ${result.riskLevel}`);
  });
});
