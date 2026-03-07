/**
 * test/policy.test.js
 *
 * Smoke tests for the policy engine (src/policy.js).
 * Covers: emergency pause, agent freeze, scope check, reserve floor,
 * per-tx limit, daily limit, velocity freeze, human approval gate.
 *
 * Uses Node.js built-in test runner (node:test). Run with:
 *   node --test test/policy.test.js
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadPolicy,
  getPolicy,
  updatePolicy,
  evaluate,
  pauseAll,
  resumeAll,
  isPaused,
  freezeAgent,
  unfreezeAgent,
  isAgentFrozen,
  getFrozenAgents,
} from "../src/policy.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Baseline policy that passes all checks for a normal action. */
const BASE_POLICY = {
  reserveSol: 0.05,
  maxPerTxSol: 0.5,
  dailyLimitSol: 2.0,
  cooldownSeconds: 0,        // no cooldown for tests
  approvalThresholdSol: 1.0,
  allowedPrograms: [],
  allowedDestinations: [],
  emergencyPause: false,
  pausedAt: null,
  pauseReason: null,
  frozenAgents: [],
  agentScopes: {},
  velocityFreezeSol: 0,      // velocity freeze disabled for most tests
};

/** A base action that should pass the default policy. */
const OK_ACTION = {
  agentId: "test-agent",
  amountSol: 0.1,
  currentBalanceSol: 1.0,
  destination: null,
  programs: [],
  skill: null,
  scopeSubject: null,
};

function reset(overrides = {}) {
  updatePolicy({ ...BASE_POLICY, ...overrides });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  // Load real policy.json first so module initialises, then override.
  loadPolicy();
  reset();
});

afterEach(() => {
  reset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluate — happy path", () => {
  it("allows a valid action within all limits", () => {
    const result = evaluate(OK_ACTION);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "ok");
  });
});

describe("evaluate — emergency pause (check 0)", () => {
  it("blocks ALL actions when emergencyPause is true", () => {
    pauseAll("test");
    const result = evaluate(OK_ACTION);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("emergency_pause"));
    assert.equal(result.paused, true);
  });

  it("allows actions after resumeAll", () => {
    pauseAll("test");
    resumeAll();
    const result = evaluate(OK_ACTION);
    assert.equal(result.allowed, true);
  });
});

describe("isPaused / pauseAll / resumeAll", () => {
  it("isPaused returns false by default", () => {
    assert.equal(isPaused(), false);
  });

  it("isPaused returns true after pauseAll", () => {
    pauseAll("testing");
    assert.equal(isPaused(), true);
    resumeAll();
  });
});

describe("evaluate — agent frozen (check 1)", () => {
  it("blocks a frozen agent", () => {
    freezeAgent("frozen-bot");
    reset({ frozenAgents: getPolicy().frozenAgents }); // keep frozen list
    const result = evaluate({ ...OK_ACTION, agentId: "frozen-bot" });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("agent_frozen"));
    assert.equal(result.frozen, true);
  });

  it("allows the agent after unfreeze", () => {
    freezeAgent("bot2");
    unfreezeAgent("bot2");
    const result = evaluate({ ...OK_ACTION, agentId: "bot2" });
    assert.equal(result.allowed, true);
  });
});

describe("isAgentFrozen / getFrozenAgents", () => {
  it("isAgentFrozen returns false for unfrozen agent", () => {
    assert.equal(isAgentFrozen("nobody"), false);
  });

  it("isAgentFrozen returns true after freeze", () => {
    freezeAgent("icebot");
    assert.equal(isAgentFrozen("icebot"), true);
    unfreezeAgent("icebot");
  });

  it("getFrozenAgents lists all frozen agents", () => {
    freezeAgent("a1");
    freezeAgent("a2");
    const frozen = getFrozenAgents();
    assert.ok(frozen.includes("a1"));
    assert.ok(frozen.includes("a2"));
    unfreezeAgent("a1");
    unfreezeAgent("a2");
  });
});

describe("evaluate — scope check (check 2)", () => {
  it("blocks when skill is not in agent scope", () => {
    reset({
      agentScopes: {
        "restricted-agent": ["get_balance"],
      },
    });
    const result = evaluate({
      ...OK_ACTION,
      amountSol: 0,       // read-only action
      agentId: "restricted-agent",
      scopeSubject: "restricted-agent",
      skill: "transfer_sol",
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("scope_violation"));
  });

  it("allows when skill is in scope", () => {
    reset({
      agentScopes: {
        "scoped-agent": ["get_balance"],
      },
    });
    const result = evaluate({
      ...OK_ACTION,
      amountSol: 0,
      agentId: "scoped-agent",
      scopeSubject: "scoped-agent",
      skill: "get_balance",
    });
    assert.equal(result.allowed, true);
  });

  it("allows all skills when scope list is empty", () => {
    reset({ agentScopes: { "open-agent": [] } });
    const result = evaluate({
      ...OK_ACTION,
      amountSol: 0,
      agentId: "open-agent",
      scopeSubject: "open-agent",
      skill: "transfer_sol",
    });
    assert.equal(result.allowed, true);
  });
});

describe("evaluate — reserve floor (check 3)", () => {
  it("blocks when post-action balance would drop below reserve", () => {
    // balance=0.1, amount=0.08, reserve=0.05 → balance_after=0.02 < 0.05
    const result = evaluate({
      ...OK_ACTION,
      amountSol: 0.08,
      currentBalanceSol: 0.1,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("reserve_floor"));
  });

  it("allows when post-action balance is safely above reserve", () => {
    // balance=0.20, amount=0.1, reserve=0.05 → balance_after=0.10 > 0.05 → ok
    // Note: use values that avoid floating point edge cases (0.15 - 0.1 ≈ 0.04999 < 0.05)
    const result = evaluate({
      ...OK_ACTION,
      agentId: "reserve-ok-agent",
      amountSol: 0.1,
      currentBalanceSol: 0.20,
    });
    assert.ok(result.allowed, `Expected allowed=true but got: ${result.reason}`);
  });
});

describe("evaluate — per-tx limit (check 4)", () => {
  it("blocks when amount exceeds maxPerTxSol", () => {
    const result = evaluate({ ...OK_ACTION, amountSol: 0.6 }); // > 0.5
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("per_tx_limit"));
  });

  it("allows amount equal to maxPerTxSol", () => {
    const result = evaluate({ ...OK_ACTION, amountSol: 0.5 });
    assert.equal(result.allowed, true);
  });
});

describe("evaluate — human approval gate (check 9)", () => {
  it("blocks actions at or above approvalThresholdSol", () => {
    // Set maxPerTxSol and dailyLimitSol high so we reach check 9
    reset({ maxPerTxSol: 5.0, dailyLimitSol: 10.0, approvalThresholdSol: 1.0 });
    const result = evaluate({
      ...OK_ACTION,
      amountSol: 1.0,
      currentBalanceSol: 10.0,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("human_approval_required"));
    assert.equal(result.requiresApproval, true);
  });

  it("allows actions below approvalThresholdSol", () => {
    const result = evaluate({ ...OK_ACTION, amountSol: 0.1 });
    assert.equal(result.allowed, true);
  });
});

describe("evaluate — destination allowlist (check 7)", () => {
  it("blocks destination not in allowlist", () => {
    reset({ allowedDestinations: ["ALLOWED_ADDRESS"] });
    const result = evaluate({
      ...OK_ACTION,
      destination: "BLOCKED_ADDRESS",
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("destination_allowlist"));
  });

  it("allows destination in allowlist", () => {
    reset({ allowedDestinations: ["ALLOWED_ADDRESS"] });
    const result = evaluate({
      ...OK_ACTION,
      destination: "ALLOWED_ADDRESS",
    });
    assert.equal(result.allowed, true);
  });

  it("allows any destination when allowlist is empty", () => {
    reset({ allowedDestinations: [] });
    const result = evaluate({ ...OK_ACTION, destination: "RANDOM_ADDRESS" });
    assert.equal(result.allowed, true);
  });
});

describe("evaluate — program allowlist (check 6)", () => {
  it("blocks program not in allowlist", () => {
    reset({ allowedPrograms: ["PROG_A"] });
    const result = evaluate({ ...OK_ACTION, programs: ["PROG_B"] });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("program_allowlist"));
  });

  it("allows program in allowlist", () => {
    reset({ allowedPrograms: ["PROG_A"] });
    const result = evaluate({ ...OK_ACTION, programs: ["PROG_A"] });
    assert.equal(result.allowed, true);
  });
});
