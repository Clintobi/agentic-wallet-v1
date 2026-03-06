/**
 * src/firewall.js
 *
 * Transaction firewall — pre-execution risk inspection layer.
 * Evaluates fund-moving skill requests before signing/sending and returns:
 *   - allow/block decision
 *   - risk score (0-100)
 *   - structured check outcomes
 */

import { PublicKey } from "@solana/web3.js";
import { MINTS, PROGRAMS } from "./config.js";
import { getPolicy } from "./policy.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ORACLE_PRICE_URL = `https://api.jup.ag/price/v2?ids=${MINTS.SOL}`;

const VALUE_MOVING_SKILLS = new Set([
  "transfer_sol",
  "transfer_usdc",
  "jupiter_swap",
  "marginfi_deposit",
  "marginfi_borrow",
  "marinade_stake",
  "marinade_unstake",
]);

const NON_MOVING_EXCEPTIONS = new Set([
  "create_payment_request",
]);

const PRICE_SENSITIVE_SKILLS = new Set([
  "jupiter_swap",
  "marginfi_deposit",
  "marginfi_borrow",
  "marinade_stake",
  "marinade_unstake",
]);

const DEFAULT_PROGRAM_HINTS = {
  transfer_sol: [SYSTEM_PROGRAM_ID],
  transfer_usdc: [PROGRAMS.TOKEN, PROGRAMS.ASSOCIATED_TOKEN],
  jupiter_swap: [PROGRAMS.JUPITER_V6, PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022, PROGRAMS.ASSOCIATED_TOKEN],
  marginfi_deposit: [PROGRAMS.MARGINFI_V2],
  marginfi_borrow: [PROGRAMS.MARGINFI_V2],
  marinade_stake: [PROGRAMS.MARINADE],
  marinade_unstake: [PROGRAMS.MARINADE],
};

const CPI_DEPTH_HINTS = {
  transfer_sol: 1,
  transfer_usdc: 2,
  marginfi_deposit: 2,
  marginfi_borrow: 2,
  marinade_stake: 2,
  marinade_unstake: 2,
  jupiter_swap: 4,
};

const KNOWN_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  ...Object.values(PROGRAMS),
]);

const KNOWN_MINTS = new Set(Object.values(MINTS));

const FIREWALL_MAX_CPI_DEPTH = numberFromEnv("FIREWALL_MAX_CPI_DEPTH", 5);
const FIREWALL_BLOCK_SCORE = numberFromEnv("FIREWALL_BLOCK_SCORE", 90);
const FIREWALL_HIGH_VALUE_SOL = numberFromEnv("FIREWALL_HIGH_VALUE_SOL", 0.5);
const ORACLE_MAX_AGE_MS = numberFromEnv("FIREWALL_ORACLE_MAX_AGE_MS", 120_000);

let oracleProbeCache = {
  ts: 0,
  ok: false,
  source: null,
  error: null,
};

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function toRiskLevel(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  if (score > 0) return "low";
  return "none";
}

function pushCheck(checks, id, status, detail) {
  checks.push({ id, status, detail });
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function extractDestination(params = {}) {
  return params.toAddress || params.recipient || params.destination || null;
}

function parseAmountSol(params = {}) {
  const amountSol = Number(params.amountSol);
  const amountUsdc = Number(params.amountUsdc);
  if (Number.isFinite(amountSol) && amountSol > 0) return amountSol;
  if (Number.isFinite(amountUsdc) && amountUsdc > 0) return amountUsdc;
  return 0;
}

function isFundMovingSkill(skillName, params = {}) {
  if (NON_MOVING_EXCEPTIONS.has(skillName)) return false;
  if (VALUE_MOVING_SKILLS.has(skillName)) return true;
  const amount = parseAmountSol(params);
  return amount > 0 && !!extractDestination(params);
}

function resolveMint(mintLike) {
  if (!mintLike) return null;
  return MINTS[mintLike] || mintLike;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveTargets({ skillName, skill, params }) {
  const skillPrograms = Array.isArray(skill?.programs) ? skill.programs : [];
  const hints = DEFAULT_PROGRAM_HINTS[skillName] || [];
  const programs = dedupe([...hints, ...skillPrograms].filter(v => KNOWN_PROGRAM_IDS.has(v) || !KNOWN_MINTS.has(v)));

  const mints = [];
  if (params?.inputMint) mints.push(resolveMint(params.inputMint));
  if (params?.outputMint) mints.push(resolveMint(params.outputMint));
  if (skillName === "transfer_usdc") mints.push(MINTS.USDC);

  const all = dedupe([...programs, ...mints]);
  return { programs, mints: dedupe(mints), all };
}

function estimateCpiDepth(skillName, params = {}) {
  if (skillName === "jupiter_swap") {
    const slippageBps = Number(params.slippageBps ?? 50);
    if (Number.isFinite(slippageBps) && slippageBps > 150) return 5;
    return 4;
  }
  return CPI_DEPTH_HINTS[skillName] ?? 2;
}

async function probeOracleFreshness() {
  const now = Date.now();
  if (oracleProbeCache.ok && (now - oracleProbeCache.ts) < ORACLE_MAX_AGE_MS) {
    return {
      ok: true,
      source: oracleProbeCache.source,
      fetchedAt: oracleProbeCache.ts,
      ageMs: now - oracleProbeCache.ts,
      cached: true,
    };
  }

  try {
    const resp = await fetch(ORACLE_PRICE_URL, { signal: AbortSignal.timeout(2500) });
    if (!resp.ok) throw new Error(`oracle_http_${resp.status}`);
    const data = await resp.json();
    const price = data?.data?.[MINTS.SOL]?.price;
    if (!Number.isFinite(Number(price))) throw new Error("oracle_invalid_payload");

    oracleProbeCache = { ts: now, ok: true, source: "jupiter_price_api", error: null };
    return {
      ok: true,
      source: "jupiter_price_api",
      fetchedAt: now,
      ageMs: 0,
      cached: false,
    };
  } catch (e) {
    oracleProbeCache = {
      ts: now,
      ok: false,
      source: null,
      error: e?.message || String(e),
    };
    return {
      ok: false,
      source: null,
      fetchedAt: now,
      ageMs: null,
      cached: false,
      error: oracleProbeCache.error,
    };
  }
}

/**
 * Run pre-execution firewall checks for a skill invocation.
 *
 * @param {object} args
 * @param {string} args.skillName
 * @param {object} args.skill
 * @param {object} args.params
 * @param {object} args.context
 * @returns {Promise<object>}
 */
export async function evaluateFirewall({ skillName, skill, params = {}, context = {} }) {
  const checks = [];
  const reasons = [];
  let blocked = false;
  let score = 0;

  const amountSol = parseAmountSol(params);
  const destination = extractDestination(params);
  const movingFunds = isFundMovingSkill(skillName, params);

  if (!movingFunds) {
    pushCheck(checks, "scope", "pass", "read_only_or_non_fund_moving_skill");
    return {
      evaluated: false,
      allowed: true,
      blocked: false,
      riskScore: 0,
      riskLevel: "none",
      reasons: [],
      checks,
      amountSol,
      destination,
      inspectedAt: new Date().toISOString(),
    };
  }

  // 1) Destination checks
  if (destination) {
    try {
      const to = new PublicKey(destination).toBase58();
      pushCheck(checks, "destination_format", "pass", to);
      const policy = getPolicy();
      if (Array.isArray(policy.allowedDestinations) && policy.allowedDestinations.length > 0
        && !policy.allowedDestinations.includes(to)) {
        blocked = true;
        reasons.push(`firewall_destination_blocked:${to}`);
        score += 100;
        pushCheck(checks, "destination_allowlist", "block", `destination_not_allowed:${to}`);
      } else {
        pushCheck(checks, "destination_allowlist", "pass", "destination_allowed_or_allowlist_disabled");
      }
    } catch {
      blocked = true;
      reasons.push("firewall_invalid_destination");
      score += 100;
      pushCheck(checks, "destination_format", "block", "invalid_solana_address");
    }
  } else {
    pushCheck(checks, "destination_format", "warn", "destination_not_provided");
    score += 5;
  }

  // 2) Program/instruction target checks
  const targets = resolveTargets({ skillName, skill, params });
  const unknownTargets = targets.all.filter(t => !KNOWN_PROGRAM_IDS.has(t) && !KNOWN_MINTS.has(t));
  if (unknownTargets.length > 0) {
    score += Math.min(40, unknownTargets.length * 20);
    reasons.push(`firewall_unknown_targets:${unknownTargets[0]}`);
    pushCheck(checks, "target_recognition", "warn", `unknown=${unknownTargets.join(",")}`);
  } else {
    pushCheck(checks, "target_recognition", "pass", "all_targets_known");
  }

  const policy = getPolicy();
  if (Array.isArray(policy.allowedPrograms) && policy.allowedPrograms.length > 0) {
    const blockedPrograms = targets.programs.filter(p => !policy.allowedPrograms.includes(p));
    if (blockedPrograms.length > 0) {
      blocked = true;
      score += 100;
      reasons.push(`firewall_program_blocked:${blockedPrograms[0]}`);
      pushCheck(checks, "program_allowlist", "block", `unauthorized_program=${blockedPrograms[0]}`);
    } else {
      pushCheck(checks, "program_allowlist", "pass", "all_programs_allowed");
    }
  } else {
    pushCheck(checks, "program_allowlist", "pass", "allowlist_disabled");
  }

  // 3) CPI depth risk checks
  const cpiDepth = estimateCpiDepth(skillName, params);
  if (cpiDepth > FIREWALL_MAX_CPI_DEPTH) {
    blocked = true;
    score += 100;
    reasons.push(`firewall_cpi_depth_exceeded:${cpiDepth}>${FIREWALL_MAX_CPI_DEPTH}`);
    pushCheck(checks, "cpi_depth", "block", `estimated_depth=${cpiDepth}`);
  } else if (cpiDepth >= FIREWALL_MAX_CPI_DEPTH - 1) {
    score += 10;
    pushCheck(checks, "cpi_depth", "warn", `near_limit depth=${cpiDepth}`);
  } else {
    pushCheck(checks, "cpi_depth", "pass", `depth=${cpiDepth}`);
  }

  // 4) Oracle freshness checks for price-sensitive skills
  if (PRICE_SENSITIVE_SKILLS.has(skillName)) {
    const oracle = await probeOracleFreshness();
    if (!oracle.ok) {
      score += 20;
      reasons.push(`firewall_oracle_unreachable:${oracle.error || "unknown"}`);
      pushCheck(checks, "oracle_freshness", "warn", `unreachable:${oracle.error || "unknown"}`);
    } else if (oracle.ageMs > ORACLE_MAX_AGE_MS) {
      blocked = true;
      score += 100;
      reasons.push(`firewall_oracle_stale:${oracle.ageMs}ms`);
      pushCheck(checks, "oracle_freshness", "block", `stale_age_ms=${oracle.ageMs}`);
    } else {
      pushCheck(checks, "oracle_freshness", "pass", `age_ms=${oracle.ageMs}`);
    }
  } else {
    pushCheck(checks, "oracle_freshness", "pass", "not_required_for_skill");
  }

  // 5) Amount sizing risk checks
  if (amountSol >= FIREWALL_HIGH_VALUE_SOL) {
    score += 20;
    reasons.push(`firewall_high_value:${amountSol}`);
    pushCheck(checks, "amount_sizing", "warn", `amount_sol=${amountSol}`);
  } else {
    pushCheck(checks, "amount_sizing", "pass", `amount_sol=${amountSol}`);
  }

  score = clampScore(score);
  if (score >= FIREWALL_BLOCK_SCORE) {
    blocked = true;
    reasons.push(`firewall_risk_threshold:${score}>=${FIREWALL_BLOCK_SCORE}`);
  }

  return {
    evaluated: true,
    allowed: !blocked,
    blocked,
    riskScore: score,
    riskLevel: toRiskLevel(score),
    reasons,
    checks,
    amountSol,
    destination,
    targets: targets.all,
    inspectedAt: new Date().toISOString(),
    actor: context?.agentName || context?.agentId || "unknown",
  };
}

