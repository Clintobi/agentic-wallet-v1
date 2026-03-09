/**
 * test/retry.test.js
 *
 * Tests for src/retry.js:
 *   - classifyError: correct code assignment for each error class
 *   - withRetry: retries on retryable errors, rejects fast on fatal errors,
 *     respects maxAttempts, calls onRetry callback
 *
 * No network calls — all tests run offline.
 *
 * Run: node --test test/retry.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError, withRetry, ERROR_CODES } from "../src/retry.js";

// ── classifyError ─────────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies rpc_timeout errors", () => {
    const c = classifyError(new Error("Request timed out"));
    assert.equal(c.code, ERROR_CODES.RPC_TIMEOUT);
    assert.ok(c.retryable);
    assert.ok(!c.fatal);
  });

  it("classifies blockhash_expired errors", () => {
    const c = classifyError(new Error("Blockhash not found"));
    assert.equal(c.code, ERROR_CODES.BLOCKHASH_EXPIRED);
    assert.ok(c.retryable);
  });

  it("classifies connection_error from ECONNREFUSED", () => {
    const c = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:8899"));
    assert.equal(c.code, ERROR_CODES.CONNECTION_ERROR);
    assert.ok(c.retryable);
  });

  it("classifies rate_limited from 429", () => {
    const c = classifyError(new Error("HTTP 429 too many requests"));
    assert.equal(c.code, ERROR_CODES.RATE_LIMITED);
    assert.ok(c.retryable);
  });

  it("classifies simulation_failed as fatal", () => {
    const c = classifyError(new Error("simulation failed: InstructionError"));
    assert.equal(c.code, ERROR_CODES.SIMULATION_FAILED);
    assert.ok(!c.retryable);
    assert.ok(c.fatal);
  });

  it("classifies no_route as fatal", () => {
    const c = classifyError(new Error("no_route: no route found for swap"));
    assert.equal(c.code, ERROR_CODES.NO_ROUTE);
    assert.ok(c.fatal);
  });

  it("classifies price_impact_too_high as fatal", () => {
    const c = classifyError(new Error("price impact too high: 12%"));
    assert.equal(c.code, ERROR_CODES.PRICE_IMPACT);
    assert.ok(c.fatal);
  });

  it("classifies policy_blocked as fatal", () => {
    const c = classifyError(new Error("not allowed by policy: daily_limit exceeded"));
    assert.equal(c.code, ERROR_CODES.POLICY_BLOCKED);
    assert.ok(c.fatal);
  });

  it("classifies insufficient_funds as fatal", () => {
    const c = classifyError(new Error("insufficient funds for transaction"));
    assert.equal(c.code, ERROR_CODES.INSUFFICIENT_FUNDS);
    assert.ok(c.fatal);
  });

  it("classifies unknown errors as non-retryable", () => {
    const c = classifyError(new Error("something completely unexpected"));
    assert.equal(c.code, ERROR_CODES.UNKNOWN);
    assert.ok(!c.retryable);
    assert.ok(!c.fatal);
  });

  it("handles string errors", () => {
    const c = classifyError("timed out");
    assert.equal(c.code, ERROR_CODES.RPC_TIMEOUT);
  });

  it("handles null/undefined gracefully", () => {
    const c = classifyError(null);
    assert.equal(c.code, ERROR_CODES.UNKNOWN);
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns value immediately on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on retryable error and succeeds on second attempt", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("Request timed out");
      return "recovered";
    }, { maxAttempts: 3, baseDelayMs: 1, jitter: false });
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("throws immediately on fatal error without retrying", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error("simulation failed: bad instruction");
      }, { maxAttempts: 3, baseDelayMs: 1 }),
      /simulation failed/,
    );
    assert.equal(calls, 1, "Fatal errors must not be retried");
  });

  it("stops after maxAttempts for retryable errors", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error("Request timed out");
      }, { maxAttempts: 3, baseDelayMs: 1, jitter: false }),
      /timed out/,
    );
    assert.equal(calls, 3, "Should retry exactly maxAttempts times");
  });

  it("calls onRetry callback with attempt info", async () => {
    const retries = [];
    await assert.rejects(
      withRetry(
        async () => { throw new Error("connect ECONNREFUSED"); },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          jitter: false,
          onRetry: (info) => retries.push(info),
        },
      ),
    );
    assert.equal(retries.length, 2, "onRetry called for attempts 1 and 2 (not last)");
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[1].attempt, 2);
  });

  it("throws on unknown errors after one attempt (not retryable, not fatal)", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error("completely unknown error");
      }, { maxAttempts: 3, baseDelayMs: 1 }),
    );
    // Unknown errors are not retryable — should fail on attempt 1
    assert.equal(calls, 1);
  });
});
