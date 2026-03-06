/**
 * src/skills/accountant.js
 *
 * DeFi Accountant agent — balance tracking + yield calculation.
 *
 * On each heartbeat tick:
 *   1. Fetch current SOL balance
 *   2. Fetch current SOL price (simulated)
 *   3. Record balance_snapshot in DB
 *   4. Compute yield/P&L since first snapshot
 *
 * Registered skills:
 *   get_yield_summary   — returns P&L, yield %, snapshots, sparkline data
 *   get_snapshots       — returns raw balance_snapshots for an agent
 *   get_portfolio_pnl   — portfolio-level P&L across all snapshot agents
 */

import { register } from "./registry.js";
import { snapQueries, logEvent } from "../db.js";
import { getBalanceSol } from "../wallet.js";
import { getSimulatedPrice } from "./guardian.js";

// ── Accountant tick — called from heartbeat dispatchRole ──────────────────────

export async function runAccountantTick(context) {
  const { agentId } = context;
  const price = getSimulatedPrice();

  let balance = null;
  try {
    balance = await getBalanceSol(context.signer.publicKey.toBase58());
  } catch { /* RPC unavailable — still record price-only snapshot */ }

  // Record snapshot even if balance is null (price-only)
  const balanceSol = balance ?? 0;
  const balanceUsd = parseFloat((balanceSol * price).toFixed(4));

  snapQueries.insert.run(agentId, balanceSol, price, balanceUsd, "heartbeat");
  logEvent("accountant_snapshot", { balance: balanceSol, price, balanceUsd }, agentId);

  // Compute yield since first snapshot
  const first  = snapQueries.getFirst.get(agentId);
  const last   = snapQueries.getLast.get(agentId);

  let yieldSol = 0;
  let yieldUsd = 0;
  let yieldPct = 0;

  if (first && last && first.balance_sol > 0) {
    yieldSol = parseFloat((last.balance_sol - first.balance_sol).toFixed(6));
    yieldUsd = parseFloat((last.balance_usd - first.balance_usd).toFixed(4));
    yieldPct = parseFloat(((yieldSol / first.balance_sol) * 100).toFixed(3));
  }

  return {
    ok:         true,
    decision:   "snapshot_recorded",
    balance:    balanceSol,
    price,
    balanceUsd,
    yieldSol,
    yieldUsd,
    yieldPct,
    snapshots:  last ? 1 : 0,
  };
}

// ── Registered skills ─────────────────────────────────────────────────────────

register({
  name:        "get_yield_summary",
  description: "Returns P&L, yield %, and sparkline data for an agent",
  params:      { agentId: "string", limit: "number (optional, default 50)" },
  async handler({ agentId, limit = 50 }, _context) {
    if (!agentId) return { ok: false, error: "agentId required" };

    const snaps  = snapQueries.getByAgent.all(agentId, Math.min(limit, 200));
    const first  = snapQueries.getFirst.get(agentId);
    const last   = snapQueries.getLast.get(agentId);

    if (!first || !last) return { ok: true, snaps: [], yieldSol: 0, yieldUsd: 0, yieldPct: 0 };

    const yieldSol = parseFloat((last.balance_sol - first.balance_sol).toFixed(6));
    const yieldUsd = parseFloat((last.balance_usd - (first.balance_usd ?? 0)).toFixed(4));
    const yieldPct = first.balance_sol > 0
      ? parseFloat(((yieldSol / first.balance_sol) * 100).toFixed(3))
      : 0;

    // Sparkline: last 24 points
    const sparkline = snaps.slice(0, 24).reverse().map(s => ({
      ts:         s.created_at * 1000,
      balanceSol: s.balance_sol,
      balanceUsd: s.balance_usd,
      price:      s.sol_price,
    }));

    return {
      ok:       true,
      agentId,
      first:    { balance_sol: first.balance_sol, balance_usd: first.balance_usd, ts: first.created_at * 1000 },
      last:     { balance_sol: last.balance_sol,  balance_usd: last.balance_usd,  ts: last.created_at * 1000 },
      yieldSol,
      yieldUsd,
      yieldPct,
      snapCount: snaps.length,
      sparkline,
    };
  },
});

register({
  name:        "get_snapshots",
  description: "Returns raw balance snapshots for an agent",
  params:      { agentId: "string", limit: "number" },
  async handler({ agentId, limit = 30 }, _context) {
    if (!agentId) return { ok: false, error: "agentId required" };
    const snaps = snapQueries.getByAgent.all(agentId, Math.min(limit, 200));
    return { ok: true, snaps };
  },
});

register({
  name:        "get_portfolio_pnl",
  description: "Returns overall portfolio P&L across all tracked agents",
  params:      {},
  async handler(_params, _context) {
    const recent = snapQueries.getRecent.all(200);

    // Group by agent_id, take first and last
    const byAgent = {};
    for (const snap of recent) {
      if (!byAgent[snap.agent_id]) byAgent[snap.agent_id] = { snaps: [] };
      byAgent[snap.agent_id].snaps.push(snap);
    }

    let totalYieldUsd = 0;
    const breakdown   = [];

    for (const [aid, data] of Object.entries(byAgent)) {
      const sorted = data.snaps.sort((a, b) => a.created_at - b.created_at);
      const first  = sorted[0];
      const last   = sorted[sorted.length - 1];

      const yieldSol = last.balance_sol - first.balance_sol;
      const yieldUsd = (last.balance_usd ?? 0) - (first.balance_usd ?? 0);
      totalYieldUsd += yieldUsd;

      breakdown.push({ agentId: aid, yieldSol: parseFloat(yieldSol.toFixed(6)),
        yieldUsd: parseFloat(yieldUsd.toFixed(4)), snapCount: sorted.length });
    }

    return {
      ok: true,
      totalYieldUsd: parseFloat(totalYieldUsd.toFixed(4)),
      breakdown,
    };
  },
});
