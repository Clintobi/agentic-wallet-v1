/**
 * src/idempotency.js
 *
 * Idempotency key enforcement for value-moving skill executions.
 * Prevents duplicate transactions from replays or double-submits.
 *
 * Storage: SQLite `skill_idempotency` table (already defined in db.js).
 * Key format: SHA-256("${agentId}:${skill}:${userKey}")
 * TTL: 24 hours (configurable via IDEMPOTENCY_TTL_HOURS env var).
 *
 * Usage:
 *   const { hit, result } = checkIdempotency(key, agentId, skill);
 *   if (hit) return result;  // cached — skip execution
 *   const result = await execute(...);
 *   recordIdempotency(key, agentId, skill, result);
 *   return result;
 */

import crypto from "crypto";
import { idempotencyQueries } from "./db.js";

const TTL_SECONDS = (Number(process.env.IDEMPOTENCY_TTL_HOURS) || 24) * 3600;

// Skills that MUST deduplicate (value-moving actions)
export const IDEMPOTENT_SKILLS = new Set([
  "transfer_sol",
  "transfer_usdc",
  "jupiter_swap",
  "marginfi_deposit",
  "marginfi_borrow",
  "marinade_stake",
  "marinade_unstake",
  "proof_of_execution",
]);

// ── Key hashing ───────────────────────────────────────────────────────────────

function hashKey(userKey, agentId, skill) {
  return crypto
    .createHash("sha256")
    .update(`${agentId}:${skill}:${userKey}`)
    .digest("hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if this key has already been executed successfully.
 * Returns the cached result if so.
 *
 * @param {string|null} key
 * @param {string} agentId
 * @param {string} skill
 * @returns {{ hit: boolean, result?: object, cachedAt?: number }}
 */
export function checkIdempotency(key, agentId, skill) {
  if (!key) return { hit: false };
  try {
    const keyHash = hashKey(key, agentId, skill);
    const row = idempotencyQueries.getActive.get(keyHash);
    if (!row) return { hit: false };
    return {
      hit:      true,
      result:   JSON.parse(row.result),
      cachedAt: row.created_at,
      keyHash,
    };
  } catch {
    return { hit: false };
  }
}

/**
 * Record a successful execution result for replay prevention.
 *
 * @param {string|null} key
 * @param {string} agentId
 * @param {string} skill
 * @param {object} result
 */
export function recordIdempotency(key, agentId, skill, result) {
  if (!key) return;
  try {
    const keyHash  = hashKey(key, agentId, skill);
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    idempotencyQueries.upsert.run({
      key_hash:   keyHash,
      key_text:   key,
      skill,
      result:     JSON.stringify(result),
      expires_at: expiresAt,
    });
  } catch {
    // Non-fatal — execution already succeeded; idempotency log is best-effort
  }
}

/**
 * Generate a time-bucketed auto-idempotency key from request params.
 * Bucket size: 1 minute — same request within 60 s reuses cached result.
 *
 * @param {string} skill
 * @param {object} params
 * @param {string} agentId
 * @returns {string}
 */
export function generateIdempotencyKey(skill, params, agentId) {
  const bucket = Math.floor(Date.now() / 60_000); // 1-min window
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ skill, params, agentId, bucket }))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Delete expired idempotency records. Safe to call on any schedule.
 *
 * @returns {number} rows deleted
 */
export function pruneIdempotencyCache() {
  try {
    return idempotencyQueries.deleteExpired.run().changes;
  } catch {
    return 0;
  }
}
