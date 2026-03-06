/**
 * src/skills/airdrop_farmer.js
 *
 * Airdrop Farmer agent — protocol activity scheduler.
 *
 * Strategy: rotate through DeFi protocols (Jupiter, MarginFi, Marinade) to
 * build on-chain history. Projects use on-chain activity for airdrop eligibility.
 *
 * Rotation schedule:
 *   tick 0 → Jupiter: get_quote (price check, no tx)
 *   tick 1 → MarginFi: marginfi_get_rates (rate check, no tx)
 *   tick 2 → Marinade: get_stake_rate (stake rate check, no tx)
 *   tick 3 → Jupiter: actual get_sol_price call
 *   tick 4 → MarginFi: marginfi_get_rates with SOL
 *   tick 5 → Marinade: marinade_stake (real micro-stake 0.001 SOL)
 *   ... repeats, cycling through more protocols each rotation
 *
 * Protocols tracked:
 *   - jupiter   (swap aggregator)
 *   - marginfi  (lending/borrowing)
 *   - marinade  (liquid staking)
 *
 * Registered skills:
 *   get_farmer_status   — last-touch per protocol, total activity count
 *   get_farmer_activity — full protocol activity log
 */

import { register } from "./registry.js";
import { execute } from "./registry.js";
import { protoQueries, logEvent } from "../db.js";

// ── Protocol rotation sequence ────────────────────────────────────────────────

const ROTATION = [
  { protocol: "jupiter",  action: "price_check",      skill: "get_sol_price",      params: {} },
  { protocol: "marginfi", action: "rate_check",        skill: "marginfi_get_rates", params: { token: "USDC" } },
  { protocol: "marinade", action: "stake_rate_check",  skill: "get_stake_rate",     params: {} },
  { protocol: "jupiter",  action: "quote_check",       skill: "get_quote",          params: { inputMint: "SOL", outputMint: "USDC", amountSol: 0.1 } },
  { protocol: "marginfi", action: "sol_rate_check",    skill: "marginfi_get_rates", params: { token: "SOL" } },
  { protocol: "marinade", action: "micro_stake",       skill: "marinade_stake",     params: { amountSol: 0.001 } },
];

// Track rotation index per agent (in-process, resets on restart — that's fine)
const rotationIndex = new Map();

export async function runFarmerTick(context) {
  const { agentId } = context;

  const idx    = rotationIndex.get(agentId) ?? 0;
  const step   = ROTATION[idx % ROTATION.length];
  rotationIndex.set(agentId, (idx + 1) % ROTATION.length);

  let result;
  try {
    result = await execute(step.skill, step.params, context);
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  // Record activity
  protoQueries.insert.run(
    agentId,
    step.protocol,
    step.action,
    JSON.stringify({ skill: step.skill, result: result?.ok ? "success" : "error",
      data: result })
  );

  logEvent("farmer_activity", {
    protocol: step.protocol,
    action:   step.action,
    skill:    step.skill,
    result:   result?.ok ? "success" : "error",
  }, agentId);

  // Compute touch summary
  const touches = protoQueries.getLastTouch.all(agentId);
  const touchMap = {};
  for (const t of touches) touchMap[t.protocol] = t.last_ts * 1000;

  // Score: each unique protocol touched in last 7 days = 1 point
  const DAY = 86400;
  const weekAgo = Math.floor(Date.now() / 1000) - (7 * DAY);
  const activeProtocols = touches.filter(t => t.last_ts > weekAgo).map(t => t.protocol);

  return {
    ok:              true,
    decision:        "protocol_touched",
    protocol:        step.protocol,
    action:          step.action,
    skillResult:     result?.ok ? "success" : "error",
    activeProtocols,
    activityScore:   activeProtocols.length,
    touchMap,
    rotationStep:    idx % ROTATION.length,
  };
}

// ── Registered skills ─────────────────────────────────────────────────────────

register({
  name:        "get_farmer_status",
  description: "Returns last-touch per protocol and activity score for an agent",
  params:      { agentId: "string" },
  async handler({ agentId }, _context) {
    if (!agentId) return { ok: false, error: "agentId required" };

    const touches  = protoQueries.getLastTouch.all(agentId);
    const touchMap = {};
    for (const t of touches) touchMap[t.protocol] = { lastTs: t.last_ts * 1000,
      lastTsHuman: new Date(t.last_ts * 1000).toISOString() };

    const protocols  = ["jupiter", "marginfi", "marinade"];
    const now        = Date.now();
    const DAY        = 86400000;

    const status = protocols.map(p => ({
      protocol: p,
      lastTouch:    touchMap[p]?.lastTs ?? null,
      hoursSince:   touchMap[p]
        ? parseFloat(((now - touchMap[p].lastTs) / 3600000).toFixed(1))
        : null,
      active7d:     touchMap[p] ? (now - touchMap[p].lastTs) < 7 * DAY : false,
    }));

    const activityScore = status.filter(s => s.active7d).length;

    return {
      ok:            true,
      agentId,
      protocols:     status,
      activityScore,
      maxScore:      protocols.length,
    };
  },
});

register({
  name:        "get_farmer_activity",
  description: "Returns the full protocol activity log for an agent",
  params:      { agentId: "string", limit: "number (optional, default 50)" },
  async handler({ agentId, limit = 50 }, _context) {
    if (!agentId) return { ok: false, error: "agentId required" };
    const activity = protoQueries.getByAgent.all(agentId);
    return {
      ok:       true,
      agentId,
      activity: activity.slice(0, Math.min(limit, 200)).map(row => ({
        ...row,
        result: row.result ? JSON.parse(row.result) : null,
        ts:     row.created_at * 1000,
      })),
    };
  },
});
