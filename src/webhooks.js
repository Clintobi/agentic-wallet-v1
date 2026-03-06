/**
 * src/webhooks.js
 *
 * Helius webhook handler — real-time on-chain event detection.
 *
 * When a payment arrives at any agent wallet or the treasury,
 * the engine fires immediately and the agent can react:
 *   incoming SOL → log event → trigger heartbeat tick → notify dashboard
 *   incoming USDC → same
 *   confirmed swap → update tx record
 *
 * Setup (one-time, requires Helius API key):
 *   node scripts/setup-webhooks.js
 *
 * For devnet demo: webhook endpoint is exposed via the dashboard server.
 * The dashboard shows incoming payments in real-time via SSE.
 *
 * Helius free tier: 1M requests/month, unlimited webhooks.
 * Sign up: https://helius.dev
 */

import { logEvent, txQueries, eventQueries } from "./db.js";
import { getAllAgents } from "./agents.js";

const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? null;

// ── Webhook request handler ───────────────────────────────────────────────────
// Mount this on POST /webhook/helius in the dashboard server

export function handleHeliusWebhook(req, res, { broadcast, onPayment }) {
  // Verify auth if secret is configured
  if (HELIUS_WEBHOOK_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${HELIUS_WEBHOOK_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const transactions = Array.isArray(req.body) ? req.body : [req.body];
  const walletAddresses = new Set(getAllAgents().map(a => a.pubkey));

  for (const tx of transactions) {
    // Detect incoming SOL payments
    for (const transfer of tx.nativeTransfers ?? []) {
      if (walletAddresses.has(transfer.toUserAccount)) {
        const event = {
          type:      "incoming_sol",
          from:      transfer.fromUserAccount,
          to:        transfer.toUserAccount,
          amount:    transfer.amount / 1e9,
          signature: tx.signature,
          ts:        tx.timestamp * 1000,
        };
        logEvent("incoming_payment", event);
        broadcast?.("incoming_payment", event);
        onPayment?.(event);
        console.log(`[webhook] Incoming SOL: ${event.amount} from ${event.from.slice(0,8)}…`);
      }
    }

    // Detect incoming USDC / SPL tokens
    for (const transfer of tx.tokenTransfers ?? []) {
      if (walletAddresses.has(transfer.toUserAccount)) {
        const event = {
          type:      "incoming_token",
          mint:      transfer.mint,
          from:      transfer.fromUserAccount,
          to:        transfer.toUserAccount,
          amount:    transfer.tokenAmount,
          signature: tx.signature,
          ts:        tx.timestamp * 1000,
        };
        logEvent("incoming_payment", event);
        broadcast?.("incoming_payment", event);
        onPayment?.(event);
        console.log(`[webhook] Incoming token: ${event.amount} ${event.mint.slice(0,8)}…`);
      }
    }

    // Update confirmed swaps
    if (tx.type === "SWAP" && tx.signature) {
      try {
        txQueries.confirm.run(tx.signature);
      } catch { /* tx may not be in our DB if it came from another source */ }
    }
  }

  res.json({ received: true, count: transactions.length });
}

// ── Helius webhook registration (run once during setup) ───────────────────────

export async function registerHeliusWebhook({ apiKey, webhookUrl, addresses }) {
  if (!apiKey) throw new Error("HELIUS_API_KEY required");

  const resp = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL:       webhookUrl,
      transactionTypes: ["TRANSFER", "SWAP"],
      accountAddresses: addresses,
      webhookType:      "enhanced",
      authHeader:       HELIUS_WEBHOOK_SECRET ? `Bearer ${HELIUS_WEBHOOK_SECRET}` : undefined,
    }),
  });

  if (!resp.ok) throw new Error(`Helius registration failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  console.log(`[webhook] Registered Helius webhook: ${data.webhookID}`);
  return data;
}
