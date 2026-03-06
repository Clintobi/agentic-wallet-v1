/**
 * src/skills/autopilot.js
 *
 * Autopilot agent — user-defined IF/THEN rule engine.
 *
 * Rules are stored in the `autopilot_rules` table.
 * Each rule has a condition (evaluated each heartbeat tick) and an action.
 *
 * Supported conditions:
 *   price_above:<usd>     — SOL price > threshold
 *   price_below:<usd>     — SOL price < threshold
 *   balance_above:<sol>   — treasury balance > threshold
 *   balance_below:<sol>   — treasury balance < threshold
 *   signal_bullish        — market signal is bullish
 *   signal_bearish        — market signal is bearish
 *   signal_neutral        — market signal is neutral
 *   always                — fires every tick (for scheduled tasks)
 *
 * Supported actions:
 *   stake:<sol>           — stake specified SOL via Marinade
 *   swap_sol_usdc:<sol>   — swap SOL to USDC via Jupiter
 *   swap_usdc_sol:<sol>   — swap USDC to SOL via Jupiter
 *   alert:<message>       — create an info alert (no on-chain action)
 *   log:<message>         — log an event (no on-chain action)
 *
 * Registered skills:
 *   autopilot_create_rule  — create a new rule
 *   autopilot_list_rules   — list all rules for an agent
 *   autopilot_delete_rule  — delete a rule
 *   autopilot_toggle_rule  — enable/disable a rule
 */

import { v4 as uuidv4 } from "uuid";
import { register } from "./registry.js";
import { ruleQueries, logEvent, insertAlert } from "../db.js";
import { execute } from "./registry.js";
import { getSimulatedPrice } from "./guardian.js";
import { getBalanceSol } from "../wallet.js";

// ── Condition evaluator ───────────────────────────────────────────────────────

async function evaluateCondition(condition, context, signal) {
  const [type, value] = condition.split(":");
  const threshold = parseFloat(value);

  switch (type) {
    case "price_above": {
      const price = getSimulatedPrice();
      return price > threshold;
    }
    case "price_below": {
      const price = getSimulatedPrice();
      return price < threshold;
    }
    case "balance_above": {
      try {
        const bal = await getBalanceSol(context.signer.publicKey.toBase58());
        return bal > threshold;
      } catch { return false; }
    }
    case "balance_below": {
      try {
        const bal = await getBalanceSol(context.signer.publicKey.toBase58());
        return bal < threshold;
      } catch { return false; }
    }
    case "signal_bullish":  return signal?.sentiment === "bullish";
    case "signal_bearish":  return signal?.sentiment === "bearish";
    case "signal_neutral":  return signal?.sentiment === "neutral";
    case "always":          return true;
    default:                return false;
  }
}

// ── Action executor ───────────────────────────────────────────────────────────

async function executeAction(action, params, context) {
  const [type, rawValue] = action.split(":");
  const value = rawValue;

  switch (type) {
    case "stake": {
      const amountSol = parseFloat(value) || 0.01;
      return execute("marinade_stake", { amountSol }, context);
    }
    case "swap_sol_usdc": {
      const amountSol = parseFloat(value) || 0.05;
      return execute("jupiter_swap", { inputMint: "SOL", outputMint: "USDC", amountSol }, context);
    }
    case "swap_usdc_sol": {
      const amountSol = parseFloat(value) || 0.05;
      return execute("jupiter_swap", { inputMint: "USDC", outputMint: "SOL", amountSol }, context);
    }
    case "alert": {
      insertAlert({ agentId: context.agentId, type: "autopilot_rule", severity: "info",
        message: value || "Autopilot rule triggered", data: params });
      return { ok: true, action: "alert_created" };
    }
    case "log": {
      logEvent("autopilot_action", { message: value, params }, context.agentId);
      return { ok: true, action: "logged" };
    }
    default:
      return { ok: false, error: `Unknown action type: ${type}` };
  }
}

// ── Autopilot tick — called from heartbeat dispatchRole ───────────────────────

export async function runAutopilotTick(context, signal) {
  const { agentId } = context;
  const rules = ruleQueries.getActive.all().filter(r => r.agent_id === agentId);

  if (rules.length === 0) {
    return {
      ok:       true,
      decision: "no_rules",
      message:  "No active rules. Create rules via the Autopilot dashboard panel.",
    };
  }

  const fired    = [];
  const skipped  = [];

  for (const rule of rules) {
    const params = JSON.parse(rule.params || "{}");

    let conditionMet = false;
    try {
      conditionMet = await evaluateCondition(rule.condition, context, signal);
    } catch (e) {
      skipped.push({ id: rule.id, name: rule.name, reason: e.message });
      continue;
    }

    if (!conditionMet) {
      skipped.push({ id: rule.id, name: rule.name, reason: "condition_not_met" });
      continue;
    }

    // Fire the rule
    let actionResult;
    try {
      actionResult = await executeAction(rule.action, params, context);
    } catch (e) {
      actionResult = { ok: false, error: e.message };
    }

    ruleQueries.updateFired.run(rule.id);
    fired.push({
      id:     rule.id,
      name:   rule.name,
      condition: rule.condition,
      action: rule.action,
      result: actionResult,
    });
    logEvent("autopilot_rule_fired", { ruleId: rule.id, name: rule.name,
      action: rule.action, result: actionResult }, agentId);
  }

  return {
    ok:       true,
    decision: fired.length > 0 ? "rules_fired" : "rules_checked",
    rulesChecked: rules.length,
    rulesFired:   fired.length,
    fired,
    skipped,
  };
}

// ── Registered skills ─────────────────────────────────────────────────────────

register({
  name:        "autopilot_create_rule",
  description: "Creates an autopilot IF/THEN rule for an agent",
  params: {
    agentId:   "string",
    name:      "string — friendly label (e.g. 'Stake when bearish')",
    condition: "string — e.g. 'price_below:140', 'signal_bullish', 'balance_below:0.5'",
    action:    "string — e.g. 'stake:0.02', 'swap_sol_usdc:0.05', 'alert:Check your wallet!'",
  },
  async handler({ agentId, name, condition, action }, _context) {
    if (!agentId || !name || !condition || !action) {
      return { ok: false, error: "agentId, name, condition, and action are required" };
    }

    const validConditions = ["price_above", "price_below", "balance_above", "balance_below",
      "signal_bullish", "signal_bearish", "signal_neutral", "always"];
    const condType = condition.split(":")[0];
    if (!validConditions.includes(condType)) {
      return { ok: false, error: `Unknown condition: ${condType}. Valid: ${validConditions.join(", ")}` };
    }

    const validActions = ["stake", "swap_sol_usdc", "swap_usdc_sol", "alert", "log"];
    const actionType = action.split(":")[0];
    if (!validActions.includes(actionType)) {
      return { ok: false, error: `Unknown action: ${actionType}. Valid: ${validActions.join(", ")}` };
    }

    const id = uuidv4();
    ruleQueries.insert.run({ id, agent_id: agentId, name, condition, action, params: "{}" });
    logEvent("autopilot_rule_created", { id, name, condition, action }, agentId);

    return { ok: true, rule: { id, agentId, name, condition, action, enabled: true } };
  },
});

register({
  name:        "autopilot_list_rules",
  description: "Lists all autopilot rules (optionally filtered by agentId)",
  params:      { agentId: "string (optional)" },
  async handler({ agentId }, _context) {
    const rules = agentId
      ? ruleQueries.getByAgent.all(agentId)
      : ruleQueries.getAll.all();
    return { ok: true, rules };
  },
});

register({
  name:        "autopilot_delete_rule",
  description: "Deletes an autopilot rule by ID",
  params:      { ruleId: "string" },
  async handler({ ruleId }, _context) {
    if (!ruleId) return { ok: false, error: "ruleId required" };
    ruleQueries.delete.run(ruleId);
    return { ok: true, deleted: ruleId };
  },
});

register({
  name:        "autopilot_toggle_rule",
  description: "Enables or disables an autopilot rule",
  params:      { ruleId: "string", enabled: "boolean" },
  async handler({ ruleId, enabled }, _context) {
    if (!ruleId) return { ok: false, error: "ruleId required" };
    ruleQueries.setEnabled.run(enabled ? 1 : 0, ruleId);
    return { ok: true, ruleId, enabled: !!enabled };
  },
});
