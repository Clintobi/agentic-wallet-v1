/**
 * src/skills/registry.js
 *
 * Skill registry — the core of the agentic wallet architecture.
 *
 * A "skill" is a self-contained wallet action with:
 *   - name:        unique identifier
 *   - description: human/LLM-readable explanation
 *   - inputSchema: Zod schema (auto-generates MCP/Claude tool definition)
 *   - handler:     async function that executes the action
 *   - policy:      optional per-skill policy overrides
 *
 * Skills are registered once and exposed to:
 *   - The MCP server (mcp/server.js) — for use by Claude, any MCP client
 *   - The agent runner (src/agent.js) — for autonomous multi-agent loops
 *   - The dashboard API (dashboard/server.js) — for manual triggering
 *
 * To add a new skill: import and call registry.register(skill).
 */

import crypto from "crypto";
import { z } from "zod";
import { evaluate as policyEval, getPolicy } from "../policy.js";
import { getBalanceSol } from "../wallet.js";
import { idempotencyQueries } from "../db.js";
import { evaluateFirewall } from "../firewall.js";
import { validateSessionForExecution } from "../sessions.js";

const skills = new Map();
const idempotencyCache = new Map(); // cacheKey -> { expiresAt, result }
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_DB_PRUNE_INTERVAL_MS = 60 * 1000;
let lastDbPruneAt = 0;
const FUND_MOVING_SKILLS = new Set([
  "transfer_sol",
  "transfer_usdc",
  "jupiter_swap",
  "marginfi_deposit",
  "marginfi_borrow",
  "marginfi_withdraw",
  "marginfi_repay",
  "marinade_stake",
  "marinade_unstake",
]);

const RETRYABLE_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "ehostunreach",
  "enotfound",
  "failed to fetch",
  "network unavailable",
  "network_unavailable",
  "network unreachable",
  "429",
  "rate limit",
  "too many requests",
  "rpc unavailable",
  "node is behind",
  "blockhash not found",
  "block height exceeded",
  "transaction expired",
  "connection closed",
];

const DETERMINISTIC_PATTERNS = [
  "session_required",
  "session_",
  "firewall_blocked",
  "firewall_",
  "simulation_failed",
  "price_impact_too_high",
  "invalid_params",
  "scope_violation",
  "reserve_floor",
  "per_tx_limit",
  "daily_limit",
  "velocity_freeze",
  "destination_allowlist",
  "program_allowlist",
  "cooldown",
  "human_approval_required",
  "emergency_pause",
  "agent_frozen",
  "insufficient",
  "minimum stake",
  "invalid",
  "not_in_scope",
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pruneIdempotencyCache() {
  const now = Date.now();
  for (const [k, v] of idempotencyCache.entries()) {
    if (v.expiresAt <= now) idempotencyCache.delete(k);
  }
}

function maybePruneIdempotencyDb() {
  const now = Date.now();
  if (now - lastDbPruneAt < IDEMPOTENCY_DB_PRUNE_INTERVAL_MS) return;
  lastDbPruneAt = now;
  try { idempotencyQueries.deleteExpired.run(); } catch { /* ignore db prune failures */ }
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function getIdempotencyCacheKey(skillName, params, context) {
  if (!context?.idempotencyKey) return null;
  return `${skillName}:${context.idempotencyKey}:${stableStringify(params ?? {})}`;
}

function hashIdempotencyKey(cacheKey) {
  return crypto.createHash("sha256").update(cacheKey).digest("hex");
}

function classifyFailureText(text) {
  const raw = String(text ?? "");
  const normalized = raw.toLowerCase();
  if (!normalized) return { code: "none", retryable: false };

  if (DETERMINISTIC_PATTERNS.some(p => normalized.includes(p))) {
    return { code: "deterministic", retryable: false };
  }
  if (RETRYABLE_PATTERNS.some(p => normalized.includes(p))) {
    return { code: "transient", retryable: true };
  }
  return { code: "unknown", retryable: false };
}

function classifyFailureResult(result) {
  if (!result || result.ok !== false) return { code: "none", retryable: false };
  const text = result.reason || result.error || "";
  return classifyFailureText(text);
}

function shouldRetrySkill(skillName, parsedData, skill) {
  if (skill?.retryConfig?.enabled === true) return true;
  const amount = parsedData?.amountSol ?? parsedData?.amountUsdc ?? 0;
  if (amount > 0) return true;
  return skillName === "jupiter_swap" || skillName === "transfer_sol" || skillName === "transfer_usdc";
}

function isFundMovingExecution(skillName, parsedData = {}) {
  if (FUND_MOVING_SKILLS.has(skillName)) return true;
  const amount = Number(parsedData.amountSol ?? parsedData.amountUsdc ?? 0);
  const destination = parsedData.toAddress ?? parsedData.recipient ?? parsedData.destination ?? null;
  return amount > 0 && !!destination;
}

function addReliability(result, meta) {
  if (!result || typeof result !== "object") return result;
  return { ...result, reliability: meta };
}

function addFirewall(result, firewall) {
  if (!result || typeof result !== "object") return result;
  if (!firewall?.evaluated) return result;
  return { ...result, firewall };
}

function addSession(result, session) {
  if (!result || typeof result !== "object") return result;
  if (!session?.session) return result;
  const s = session.session;
  return {
    ...result,
    session: {
      id: s.id,
      scopeSubject: s.scopeSubject,
      expiresAt: s.expiresAt,
      maxPerTxSol: s.maxPerTxSol,
    },
    sessionBinding: session.binding || null,
  };
}

/**
 * Register a skill.
 * @param {object} skill
 * @param {string}   skill.name
 * @param {string}   skill.description
 * @param {z.ZodObject} skill.inputSchema
 * @param {function} skill.handler  — async (params, context) => SkillResult
 * @param {object}   [skill.policyOverrides]
 */
export function register(skill) {
  if (skills.has(skill.name)) throw new Error(`Skill "${skill.name}" already registered`);
  skills.set(skill.name, skill);
}

export function getSkill(name) {
  const skill = skills.get(name);
  if (!skill) throw new Error(`Unknown skill: "${name}"`);
  return skill;
}

export function listSkills() {
  return [...skills.values()].map(s => ({
    name:        s.name,
    description: s.description,
    inputSchema: s.inputSchema ? zodToJsonSchema(s.inputSchema) : { type: "object", properties: {} },
  }));
}

/**
 * Execute a skill with policy enforcement.
 *
 * context = { signer, agentId }
 * Returns SkillResult: { ok, data?, error?, sig?, blocked?, reason? }
 */
export async function execute(skillName, params, context) {
  const skill = getSkill(skillName);
  const { signer, agentId } = context;
  const scopeSubject = context.agentName || agentId;

  // Scope check applies to ALL skills (including read-only and control skills).
  // Spend/limit checks remain guarded by amount-based policy evaluation below.
  const policy = getPolicy();
  if (scopeSubject && policy.agentScopes?.[scopeSubject]) {
    const allowedSkills = policy.agentScopes[scopeSubject];
    if (allowedSkills.length > 0 && !allowedSkills.includes(skillName)) {
      return { ok: false, blocked: true, reason: `scope_violation: subject=${scopeSubject} skill=${skillName} not_in_scope` };
    }
  }

  // Validate params against schema (if skill declares one)
  let parsed;
  if (skill.inputSchema && typeof skill.inputSchema.safeParse === "function") {
    parsed = skill.inputSchema.safeParse(params);
    if (!parsed.success) {
      return { ok: false, error: "invalid_params", detail: parsed.error.format() };
    }
  } else {
    // No schema — pass params through as-is
    parsed = { data: params ?? {} };
  }

  const idempotencyCacheKey = getIdempotencyCacheKey(skillName, parsed.data, context);
  if (idempotencyCacheKey) {
    pruneIdempotencyCache();
    maybePruneIdempotencyDb();

    const cached = idempotencyCache.get(idempotencyCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const reliability = {
        ...(cached.result?.reliability || {}),
        idempotentReplay: true,
      };
      return { ...cached.result, idempotentReplay: true, reliability };
    }

    try {
      const dbCached = idempotencyQueries.getActive.get(hashIdempotencyKey(idempotencyCacheKey));
      if (dbCached?.result) {
        const parsedResult = JSON.parse(dbCached.result);
        const expiresAt = Number(dbCached.expires_at) * 1000;
        idempotencyCache.set(idempotencyCacheKey, { expiresAt, result: parsedResult });
        const reliability = {
          ...(parsedResult?.reliability || {}),
          idempotentReplay: true,
        };
        return { ...parsedResult, idempotentReplay: true, reliability };
      }
    } catch {
      // If DB read/parse fails, continue with fresh execution path.
    }
  }

  // Policy check (if skill declares amountSol)
  const amountSol = parsed.data.amountSol ?? parsed.data.amountUsdc ?? 0;
  const destination = parsed.data.toAddress ?? parsed.data.recipient ?? null;
  const invokedPrograms = skill.programs ?? [];
  const fundMoving = isFundMovingExecution(skillName, parsed.data);

  const firewall = await evaluateFirewall({
    skillName,
    skill,
    params: parsed.data,
    context,
  });
  if (firewall.evaluated && firewall.blocked) {
    return {
      ok: false,
      blocked: true,
      reason: `firewall_blocked: ${firewall.reasons?.[0] || "risk_threshold_exceeded"}`,
      firewall,
    };
  }

  const policyState = getPolicy();
  const providedSessionId = context.sessionId || null;
  const sessionRequired = fundMoving && (Boolean(providedSessionId) || policyState.requireSessionForFunds === true);
  let activeSession = null;
  if (sessionRequired) {
    const s = validateSessionForExecution({
      sessionId: providedSessionId,
      scopeSubject,
      skillName,
      amountSol,
      destination,
      programs: invokedPrograms,
      params: parsed.data,
      idempotencyKey: context.idempotencyKey ?? null,
      sessionProof: context.sessionProof ?? null,
      requireBindingProof: policyState.enforceSessionBoundProof !== false,
    });
    if (!s.allowed) {
      return addFirewall(addSession({
        ok: false,
        blocked: true,
        reason: s.reason,
      }, s), firewall);
    }
    activeSession = s;
  }

  if (fundMoving && amountSol > 0) {
    const balance = await getBalanceSol(signer.publicKey.toBase58()).catch(() => 0);
    const decision = policyEval({
      agentId,
      scopeSubject,
      amountSol,
      currentBalanceSol: balance,
      destination,
      programs:    invokedPrograms,
    });

    if (!decision.allowed) {
      return addFirewall(addSession({ ok: false, blocked: true, reason: decision.reason }, activeSession), firewall);
    }
  }

  const retryableSkill = shouldRetrySkill(skillName, parsed.data, skill);
  const configuredMax = Number(skill?.retryConfig?.maxAttempts);
  const maxAttempts = retryableSkill ? Math.max(1, Number.isFinite(configuredMax) ? configuredMax : 3) : 1;
  const retryReasons = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const handlerResult = await skill.handler(parsed.data, context);
      let result = { ok: true, ...handlerResult };
      const classified = classifyFailureResult(result);
      const shouldRetry = retryableSkill && classified.retryable && attempt < maxAttempts;

      if (shouldRetry) {
        retryReasons.push(classified.code);
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }

      result = addReliability(result, {
        attempts: attempt,
        retried: attempt > 1,
        retryReasons,
        class: classified.code,
        idempotencyKey: context.idempotencyKey ?? null,
      });
      result = addSession(result, activeSession);
      result = addFirewall(result, firewall);

      if (idempotencyCacheKey) {
        const expiresAt = Date.now() + IDEMPOTENCY_TTL_MS;
        idempotencyCache.set(idempotencyCacheKey, {
          expiresAt,
          result,
        });
        try {
          idempotencyQueries.upsert.run({
            key_hash:   hashIdempotencyKey(idempotencyCacheKey),
            key_text:   idempotencyCacheKey,
            skill:      skillName,
            result:     JSON.stringify(result),
            expires_at: Math.floor(expiresAt / 1000),
          });
        } catch {
          // Best-effort persistence; do not fail execution if cache write fails.
        }
      }
      return result;
    } catch (e) {
      const errorText = e?.message || String(e);
      const classified = classifyFailureText(errorText);
      const shouldRetry = retryableSkill && classified.retryable && attempt < maxAttempts;

      if (shouldRetry) {
        retryReasons.push(classified.code);
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }

      let result = addReliability({ ok: false, error: errorText }, {
        attempts: attempt,
        retried: attempt > 1,
        retryReasons,
        class: classified.code,
        idempotencyKey: context.idempotencyKey ?? null,
      });
      result = addSession(result, activeSession);
      result = addFirewall(result, firewall);
      if (idempotencyCacheKey) {
        const expiresAt = Date.now() + IDEMPOTENCY_TTL_MS;
        idempotencyCache.set(idempotencyCacheKey, {
          expiresAt,
          result,
        });
        try {
          idempotencyQueries.upsert.run({
            key_hash:   hashIdempotencyKey(idempotencyCacheKey),
            key_text:   idempotencyCacheKey,
            skill:      skillName,
            result:     JSON.stringify(result),
            expires_at: Math.floor(expiresAt / 1000),
          });
        } catch {
          // Best-effort persistence; do not fail execution if cache write fails.
        }
      }
      return result;
    }
  }

  return { ok: false, error: "unreachable_execution_path" };
}

// ── Zod → JSON Schema (minimal, covers our use cases) ────────────────────────

export function zodToJsonSchema(schema) {
  if (!schema || !schema._def) return { type: "object", properties: {} };
  const shape = schema._def.shape?.() ?? {};
  const properties = {};
  const required   = [];

  for (const [key, val] of Object.entries(shape)) {
    const def = val._def;
    const isOptional = def.typeName === "ZodOptional";
    const inner      = isOptional ? def.innerType._def : def;

    properties[key] = {
      type:        zodTypeToJsonType(inner.typeName),
      description: val.description ?? inner.description ?? undefined,
    };
    if (inner.typeName === "ZodEnum") {
      properties[key].enum = inner.values;
    }
    if (!isOptional) required.push(key);
  }

  return { type: "object", properties, required };
}

function zodTypeToJsonType(typeName) {
  switch (typeName) {
    case "ZodString":  return "string";
    case "ZodNumber":  return "number";
    case "ZodBoolean": return "boolean";
    case "ZodArray":   return "array";
    default:           return "string";
  }
}
