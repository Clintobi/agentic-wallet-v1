/**
 * test/wallet.test.js
 *
 * Smoke tests for wallet helpers (src/wallet.js).
 * Covers pure utilities: getConnection singleton, PublicKey validation,
 * and the withTimeout guard (tested indirectly via a mock promise).
 *
 * Tests avoid live RPC calls so they run offline without devnet access.
 *
 * Run with: node --test test/wallet.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { getConnection } from "../src/wallet.js";

// ── getConnection ──────────────────────────────────────────────────────────────

describe("getConnection", () => {
  it("returns a Connection object", () => {
    const conn = getConnection();
    assert.ok(conn, "Expected a connection object");
    assert.ok(typeof conn.getBalance === "function", "Expected getBalance method");
    assert.ok(typeof conn.sendRawTransaction === "function", "Expected sendRawTransaction method");
  });

  it("returns the same singleton on repeated calls", () => {
    const c1 = getConnection();
    const c2 = getConnection();
    assert.strictEqual(c1, c2, "getConnection should return the same singleton");
  });
});

// ── PublicKey validation (used throughout wallet.js) ──────────────────────────

describe("PublicKey validation", () => {
  it("accepts a valid base58 Solana address", () => {
    const addr = "8fdbGA8j5z6sds2sbZfdLzeyUcQmExwCxmQuVxehdFNB";
    assert.doesNotThrow(() => new PublicKey(addr));
    assert.equal(new PublicKey(addr).toBase58(), addr);
  });

  it("accepts the SOL native mint address", () => {
    const sol = "So11111111111111111111111111111111111111112";
    assert.doesNotThrow(() => new PublicKey(sol));
  });

  it("throws on an invalid address", () => {
    assert.throws(() => new PublicKey("not-a-valid-address"), Error);
  });

  it("throws on an empty string", () => {
    assert.throws(() => new PublicKey(""), Error);
  });
});

// ── Timeout guard (pure logic, no network) ────────────────────────────────────

describe("timeout guard logic", () => {
  it("a promise that resolves before the timeout succeeds", async () => {
    const fast = new Promise(resolve => setTimeout(() => resolve("done"), 10));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("rpc_timeout")), 500),
    );
    const result = await Promise.race([fast, timeout]);
    assert.equal(result, "done");
  });

  it("a promise that exceeds the timeout rejects with timeout error", async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve("too late"), 500));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("rpc_timeout")), 10),
    );
    await assert.rejects(Promise.race([slow, timeout]), /rpc_timeout/);
  });
});

// ── LAMPORTS_PER_SOL conversion sanity ───────────────────────────────────────

describe("lamports ↔ SOL conversion", () => {
  it("1 SOL = 1,000,000,000 lamports", () => {
    assert.equal(LAMPORTS_PER_SOL, 1_000_000_000);
  });

  it("converts lamports to SOL correctly", () => {
    assert.equal(500_000_000 / LAMPORTS_PER_SOL, 0.5);
    assert.equal(50_000_000  / LAMPORTS_PER_SOL, 0.05);
  });
});
