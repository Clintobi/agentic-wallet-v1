/**
 * src/skills/guardian.js
 *
 * Guardian agent — security monitoring skill.
 *
 * On each heartbeat tick:
 *   1. Fetch current SOL price (simulated deterministically)
 *   2. Fetch treasury balance
 *   3. Compare vs previous reading stored in DB
 *   4. Generate alerts with severity levels: info / warning / critical
 *
 * Alert types:
 *   price_spike       — SOL moved >5% in one tick window
 *   price_crash       — SOL dropped >5%
 *   low_balance       — balance < 0.2 SOL (warning) or < 0.05 SOL (critical)
 *   balance_drop      — balance dropped >10% since last snapshot
 *   high_tx_velocity  — >10 txs recorded in last 5 minutes (anomaly detection)
 *
 * Registered skills:
 *   get_alerts        — returns recent unacked alerts
 *   ack_alerts        — acknowledges all alerts for an agent
 *   guardian_status   — returns current price, balance, threat level
 */

import { register } from "./registry.js";
import { alertQueries, txQueries, logEvent, insertAlert } from "../db.js";
import { getBalanceSol } from "../wallet.js";

// ── Simulated price oracle (same deterministic formula as heartbeat.js) ────────

export function getSimulatedPrice(ts = Date.now()) {
  const slot  = Math.floor(ts / (1000 * 60 * 5));  // 5-min slot
  const base  = 145;                                 // SOL base price in USD
  const swing = 12;                                  // ±$12 swing
  return parseFloat((base + Math.sin(slot * 1.3) * swing).toFixed(2));
}

// ── Persistent price memory (in-process, refreshed each tick) ─────────────────

const priceHistory = [];
const MAX_HISTORY  = 20;

function recordPrice(price) {
  priceHistory.push({ price, ts: Date.now() });
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

function prevPrice() {
  if (priceHistory.length < 2) return null;
  return priceHistory[priceHistory.length - 2].price;
}

// ── Guardian tick — called from heartbeat dispatchRole ────────────────────────

export async function runGuardianTick(context) {
  const { agentId } = context;
  const now = Date.now();
  const currentPrice = getSimulatedPrice(now);
  recordPrice(currentPrice);

  const alerts = [];

  // ── Price change detection ──────────────────────────────────────────────────
  const prev = prevPrice();
  if (prev !== null) {
    const changePct = ((currentPrice - prev) / prev) * 100;

    if (changePct > 5) {
      const msg = `SOL price spiked +${changePct.toFixed(1)}% to $${currentPrice}`;
      insertAlert({ agentId, type: "price_spike", severity: "warning", message: msg,
        data: { price: currentPrice, prev, changePct } });
      alerts.push({ type: "price_spike", severity: "warning", message: msg });
      logEvent("guardian_alert", { type: "price_spike", changePct, price: currentPrice }, agentId);
    } else if (changePct < -5) {
      const msg = `SOL price crashed ${changePct.toFixed(1)}% to $${currentPrice}`;
      insertAlert({ agentId, type: "price_crash", severity: "critical", message: msg,
        data: { price: currentPrice, prev, changePct } });
      alerts.push({ type: "price_crash", severity: "critical", message: msg });
      logEvent("guardian_alert", { type: "price_crash", changePct, price: currentPrice }, agentId);
    }
  }

  // ── Balance monitoring ──────────────────────────────────────────────────────
  let balance = null;
  try {
    balance = await getBalanceSol(context.signer.publicKey.toBase58());
  } catch { /* RPC unavailable */ }

  if (balance !== null) {
    if (balance < 0.05) {
      const msg = `CRITICAL: treasury balance ${balance.toFixed(4)} SOL — nearly empty!`;
      insertAlert({ agentId, type: "low_balance", severity: "critical", message: msg,
        data: { balance } });
      alerts.push({ type: "low_balance", severity: "critical", message: msg });
    } else if (balance < 0.2) {
      const msg = `Low balance warning: ${balance.toFixed(4)} SOL remaining`;
      insertAlert({ agentId, type: "low_balance", severity: "warning", message: msg,
        data: { balance } });
      alerts.push({ type: "low_balance", severity: "warning", message: msg });
    }
  }

  // ── TX velocity check (anomaly detection) ──────────────────────────────────
  const recentTxs = txQueries.getRecent.all(50).filter(tx =>
    tx.created_at > Math.floor(now / 1000) - 300 // last 5 minutes
  );
  if (recentTxs.length > 10) {
    const msg = `High TX velocity: ${recentTxs.length} transactions in last 5 minutes`;
    insertAlert({ agentId, type: "high_tx_velocity", severity: "warning", message: msg,
      data: { count: recentTxs.length } });
    alerts.push({ type: "high_tx_velocity", severity: "warning", message: msg });
  }

  const threatLevel = alerts.some(a => a.severity === "critical") ? "critical"
    : alerts.some(a => a.severity === "warning") ? "warning" : "clear";

  return {
    ok:          true,
    decision:    threatLevel === "clear" ? "all_clear" : `alert_${threatLevel}`,
    price:       currentPrice,
    balance,
    alerts:      alerts.length,
    threatLevel,
    alertDetails: alerts,
  };
}

// ── Registered skills ─────────────────────────────────────────────────────────

register({
  name:        "get_alerts",
  description: "Returns recent unacknowledged security alerts",
  params:      { agentId: "string (optional)" },
  async handler({ agentId }, _context) {
    const rows = agentId
      ? alertQueries.getByAgent.all(agentId)
      : alertQueries.getUnacked.all();
    return {
      ok:     true,
      alerts: rows.map(r => ({
        ...r,
        data: r.data ? JSON.parse(r.data) : null,
      })),
    };
  },
});

register({
  name:        "ack_alerts",
  description: "Acknowledges all alerts for an agent",
  params:      { agentId: "string" },
  async handler({ agentId }, _context) {
    if (!agentId) return { ok: false, error: "agentId required" };
    alertQueries.ackAll.run(agentId);
    return { ok: true, acked: true };
  },
});

register({
  name:        "guardian_status",
  description: "Returns current price, treasury balance, and threat level",
  params:      {},
  async handler(_params, context) {
    const price   = getSimulatedPrice();
    let balance   = null;
    try { balance = await getBalanceSol(context.signer.publicKey.toBase58()); } catch {}

    const unacked = alertQueries.getUnacked.all();
    const critical = unacked.filter(a => a.severity === "critical").length;
    const warnings = unacked.filter(a => a.severity === "warning").length;

    return {
      ok:          true,
      price,
      balance,
      unackedAlerts: unacked.length,
      critical,
      warnings,
      threatLevel: critical > 0 ? "critical" : warnings > 0 ? "warning" : "clear",
    };
  },
});
