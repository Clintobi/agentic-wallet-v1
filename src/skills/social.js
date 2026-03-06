/**
 * src/skills/social.js
 *
 * Social Wallet agent — Solana Pay payment requests.
 *
 * Generates payment request URLs conforming to the Solana Pay spec:
 *   solana:<recipient>?amount=<sol>&label=<label>&memo=<memo>&reference=<ref>
 *
 * Also generates a Blink-compatible URL for sharing via Dialect/Phantom.
 *
 * Registered skills:
 *   create_payment_request   — create a new payment request
 *   list_payment_requests    — list all payment requests (optionally by agent)
 *   cancel_payment_request   — cancel a pending request
 *   check_payment_status     — check if a reference account has been funded
 *
 * The social agent heartbeat tick does periodic status polling:
 *   - Scans pending payment requests
 *   - Checks if any reference account received SOL (simulated — real impl needs Helius)
 *   - Marks paid if funded
 */

import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { register } from "./registry.js";
import { payReqQueries, logEvent } from "../db.js";
import { Keypair, PublicKey } from "@solana/web3.js";

// ── Solana Pay URL builder ─────────────────────────────────────────────────────

function buildSolanaPayUrl({ recipient, amountSol, label, memo, reference }) {
  let url = `solana:${recipient}`;
  const params = new URLSearchParams();
  if (amountSol)  params.set("amount",    amountSol.toString());
  if (label)      params.set("label",     label);
  if (memo)       params.set("memo",      memo);
  if (reference)  params.set("reference", reference);
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function buildBlinkUrl(payReqId, serverUrl = process.env.BLINK_BASE_URL || "http://localhost:3000") {
  return `${serverUrl}/actions/pay/${payReqId}`;
}

// ── Social tick — called from heartbeat dispatchRole ─────────────────────────

export async function socialTick(context) {
  const { agentId } = context;

  // Get all pending payment requests
  const pending = payReqQueries.getByAgent.all(agentId)
    .filter(r => r.status === "pending");

  if (pending.length === 0) {
    logEvent("social_tick", { status: "no_pending_requests", agentId }, agentId);
    return {
      ok:       true,
      decision: "idle",
      message:  "No pending payment requests. Create one via the Social panel.",
      pendingCount: 0,
    };
  }

  // Simulate payment detection (in a real system this uses Helius webhook or
  // connection.getSignaturesForAddress on the reference key)
  let checked = 0;
  for (const req of pending) {
    checked++;
    // Deterministic simulation: if request is >5 minutes old, 20% chance it was paid
    const ageMs = Date.now() - req.created_at * 1000;
    if (ageMs > 5 * 60 * 1000) {
      const seed = parseInt(req.reference.slice(0, 8), 16);
      const paid = (seed % 5) === 0; // 20% of refs "paid" deterministically
      if (paid && req.status === "pending") {
        const fakeSig = crypto.randomBytes(32).toString("hex");
        payReqQueries.markPaid.run(fakeSig, req.id);
        logEvent("payment_received", { payReqId: req.id, label: req.label,
          amountSol: req.amount_sol, sig: fakeSig }, agentId);
      }
    }
  }

  const stillPending = payReqQueries.getByAgent.all(agentId).filter(r => r.status === "pending").length;

  return {
    ok:           true,
    decision:     "requests_checked",
    checked,
    stillPending,
    agentId,
  };
}

// ── Registered skills ─────────────────────────────────────────────────────────

register({
  name:        "create_payment_request",
  description: "Creates a Solana Pay payment request with a shareable URL",
  params: {
    agentId:   "string — which agent to associate this with",
    label:     "string — human-readable label (e.g. 'Coffee payment')",
    memo:      "string (optional) — memo field",
    amountSol: "number (optional) — fixed amount in SOL, omit for open amount",
    recipient: "string (optional) — recipient wallet address, defaults to treasury",
  },
  async handler({ agentId, label, memo, amountSol, recipient }, context) {
    if (!agentId || !label) return { ok: false, error: "agentId and label are required" };

    const id        = uuidv4();
    const reference = new Keypair().publicKey.toBase58(); // unique reference key
    const dest      = recipient || context.signer.publicKey.toBase58();

    payReqQueries.insert.run({
      id,
      agent_id:   agentId,
      label,
      memo:       memo || null,
      amount_sol: amountSol || null,
      recipient:  dest,
      reference,
      status:     "pending",
    });

    const solanaPay = buildSolanaPayUrl({ recipient: dest, amountSol, label, memo, reference });
    const blinkUrl  = buildBlinkUrl(id);

    logEvent("payment_request_created", { id, label, amountSol, recipient: dest }, agentId);

    return {
      ok:         true,
      payReqId:   id,
      label,
      amountSol:  amountSol || null,
      recipient:  dest,
      reference,
      solanaPay,
      blinkUrl,
      qrData:     solanaPay, // QR code encodes the solanaPay URL
    };
  },
});

register({
  name:        "list_payment_requests",
  description: "Lists payment requests, optionally filtered by agent or status",
  params:      { agentId: "string (optional)", status: "string (optional) — pending|paid|cancelled" },
  async handler({ agentId, status }, _context) {
    let rows = agentId
      ? payReqQueries.getByAgent.all(agentId)
      : payReqQueries.getAll.all();

    if (status) rows = rows.filter(r => r.status === status);

    return {
      ok:       true,
      requests: rows.map(r => ({
        ...r,
        solanaPay: buildSolanaPayUrl({
          recipient:  r.recipient,
          amountSol:  r.amount_sol,
          label:      r.label,
          memo:       r.memo,
          reference:  r.reference,
        }),
        blinkUrl:  buildBlinkUrl(r.id),
        createdAt: r.created_at * 1000,
        paidAt:    r.paid_at ? r.paid_at * 1000 : null,
      })),
    };
  },
});

register({
  name:        "cancel_payment_request",
  description: "Cancels a pending payment request",
  params:      { payReqId: "string" },
  async handler({ payReqId }, _context) {
    if (!payReqId) return { ok: false, error: "payReqId required" };
    const req = payReqQueries.getById.get(payReqId);
    if (!req) return { ok: false, error: "Payment request not found" };
    if (req.status !== "pending") return { ok: false, error: `Cannot cancel: status is ${req.status}` };
    payReqQueries.cancel.run(payReqId);
    return { ok: true, cancelled: payReqId };
  },
});

register({
  name:        "check_payment_status",
  description: "Returns the current status of a payment request",
  params:      { payReqId: "string" },
  async handler({ payReqId }, _context) {
    if (!payReqId) return { ok: false, error: "payReqId required" };
    const req = payReqQueries.getById.get(payReqId);
    if (!req) return { ok: false, error: "Payment request not found" };

    return {
      ok:        true,
      payReqId,
      label:     req.label,
      amountSol: req.amount_sol,
      status:    req.status,
      paidSig:   req.paid_sig,
      paidAt:    req.paid_at ? req.paid_at * 1000 : null,
      solanaPay: buildSolanaPayUrl({
        recipient: req.recipient, amountSol: req.amount_sol,
        label: req.label, memo: req.memo, reference: req.reference,
      }),
    };
  },
});
