/**
 * src/retry.js
 *
 * Solana-aware error classification and retry-with-backoff.
 *
 * Error classes:
 *   retryable  — transient RPC/network issues; retry with exponential backoff
 *   fatal      — deterministic failures (bad route, policy block); never retry
 *   unknown    — unclassified; retry once conservatively
 *
 * Usage:
 *   import { classifyError, withRetry } from "./retry.js";
 *
 *   const result = await withRetry(
 *     () => conn.sendRawTransaction(tx.serialize()),
 *     { maxAttempts: 3, baseDelayMs: 300 }
 *   );
 */

// ── Error code constants ───────────────────────────────────────────────────────

export const ERROR_CODES = Object.freeze({
  RPC_TIMEOUT:        "rpc_timeout",
  BLOCKHASH_EXPIRED:  "blockhash_expired",
  CONNECTION_ERROR:   "connection_error",
  RATE_LIMITED:       "rate_limited",
  SIMULATION_FAILED:  "simulation_failed",
  NO_ROUTE:           "no_route",
  SLIPPAGE_EXCEEDED:  "slippage_exceeded",
  PRICE_IMPACT:       "price_impact_too_high",
  POLICY_BLOCKED:     "policy_blocked",
  FIREWALL_BLOCKED:   "firewall_blocked",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  UNKNOWN:            "unknown_error",
});

const RETRYABLE = new Set([
  ERROR_CODES.RPC_TIMEOUT,
  ERROR_CODES.BLOCKHASH_EXPIRED,
  ERROR_CODES.CONNECTION_ERROR,
  ERROR_CODES.RATE_LIMITED,
]);

const FATAL = new Set([
  ERROR_CODES.SIMULATION_FAILED,
  ERROR_CODES.NO_ROUTE,
  ERROR_CODES.SLIPPAGE_EXCEEDED,
  ERROR_CODES.PRICE_IMPACT,
  ERROR_CODES.POLICY_BLOCKED,
  ERROR_CODES.FIREWALL_BLOCKED,
  ERROR_CODES.INSUFFICIENT_FUNDS,
]);

// ── Error classification ───────────────────────────────────────────────────────

/**
 * Classify a thrown error into a structured object with retry guidance.
 *
 * @param {unknown} err
 * @returns {{ code: string, retryable: boolean, fatal: boolean, message: string, original: unknown }}
 */
export function classifyError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  const code = (() => {
    if (msg.includes("rpc_timeout") || msg.includes("timed out") || msg.includes("timeout"))
      return ERROR_CODES.RPC_TIMEOUT;
    if (msg.includes("blockhash not found") || msg.includes("blockhash_expired") || msg.includes("block height exceeded"))
      return ERROR_CODES.BLOCKHASH_EXPIRED;
    if (msg.includes("failed to fetch") || msg.includes("econnrefused") || msg.includes("network error") || msg.includes("connection_error") || msg.includes("enotfound"))
      return ERROR_CODES.CONNECTION_ERROR;
    if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests") || msg.includes("rate_limited"))
      return ERROR_CODES.RATE_LIMITED;
    if (msg.includes("simulation_failed") || msg.includes("simulation failed") || msg.includes("simulatetransaction"))
      return ERROR_CODES.SIMULATION_FAILED;
    if (msg.includes("no_route") || msg.includes("no route") || msg.includes("could not find any route"))
      return ERROR_CODES.NO_ROUTE;
    if (msg.includes("slippage") || msg.includes("slippage_exceeded"))
      return ERROR_CODES.SLIPPAGE_EXCEEDED;
    if (msg.includes("price_impact") || msg.includes("price impact too high"))
      return ERROR_CODES.PRICE_IMPACT;
    if (msg.includes("policy") || msg.includes("policy_blocked") || msg.includes("not allowed by policy"))
      return ERROR_CODES.POLICY_BLOCKED;
    if (msg.includes("firewall") || msg.includes("firewall_blocked") || msg.includes("risk score"))
      return ERROR_CODES.FIREWALL_BLOCKED;
    if (msg.includes("insufficient") || msg.includes("0x1") || msg.includes("insufficient funds"))
      return ERROR_CODES.INSUFFICIENT_FUNDS;
    return ERROR_CODES.UNKNOWN;
  })();

  return {
    code,
    retryable: RETRYABLE.has(code),
    fatal:     FATAL.has(code),
    message:   err?.message || String(err),
    original:  err,
  };
}

// ── Retry with exponential backoff ────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute fn with exponential backoff for retryable errors.
 *
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: boolean, onRetry?: function }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 300,
    maxDelayMs  = 8_000,
    jitter      = true,
    onRetry     = null,
  } = opts;

  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const classified = classifyError(err);
      lastErr = err;
      lastErr._classified = classified;

      // Don't retry fatal or on last attempt
      if (classified.fatal || !classified.retryable || attempt === maxAttempts) {
        throw lastErr;
      }

      const base      = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitterMs  = jitter ? Math.floor(Math.random() * base * 0.3) : 0;
      const delayMs   = base + jitterMs;

      if (onRetry) {
        onRetry({ attempt, maxAttempts, delayMs, code: classified.code, error: classified });
      }

      await sleep(delayMs);
    }
  }

  throw lastErr;
}
