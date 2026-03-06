/**
 * src/gasless.js
 *
 * Gasless transaction layer — agents transact with 0 SOL in their wallets.
 *
 * Strategy (two modes, auto-selected):
 *
 * 1. KORA mode (when Kora endpoint is reachable):
 *    - Build TX with Kora's pubkey as feePayer
 *    - Agent signs the authority instructions
 *    - POST to Kora /api/v1/sign_and_send_transaction
 *    - Kora co-signs as feePayer and broadcasts
 *
 * 2. TREASURY SPONSOR mode (fallback, always works):
 *    - Treasury wallet acts as feePayer
 *    - Agent signs authority, treasury signs fee
 *    - Works on devnet without any external service
 *    - This is what KLAVE calls "treasury-sponsored" TXs
 *
 * For the contest demo: treasury sponsor mode is used (no Kora devnet endpoint).
 * For mainnet production: swap KORA_URL to a live Kora instance.
 */

import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { getConnection } from "./wallet.js";

const KORA_URL = process.env.KORA_URL || null; // e.g. "https://kora.dial.to"

// ── Kora availability check ───────────────────────────────────────────────────

let _koraAvailable = null;
let _koraFeePayer  = null;

async function checkKora() {
  if (_koraAvailable !== null) return _koraAvailable;
  if (!KORA_URL) { _koraAvailable = false; return false; }

  try {
    const resp = await fetch(`${KORA_URL}/api/v1/get_config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(4_000),
    });
    if (!resp.ok) { _koraAvailable = false; return false; }
    const cfg = await resp.json();
    _koraFeePayer = cfg.feePayer ?? null;
    _koraAvailable = !!_koraFeePayer;
    console.log(`[gasless] Kora available. feePayer: ${_koraFeePayer}`);
  } catch {
    _koraAvailable = false;
  }
  return _koraAvailable;
}

// ── Core: send gasless transaction ────────────────────────────────────────────

/**
 * Send a transaction with gasless fee sponsorship.
 *
 * @param {object} opts
 * @param {TransactionInstruction[]} opts.instructions  - instructions to execute
 * @param {object}  opts.agentSigner    - the agent's WalletSigner (signs authority)
 * @param {object}  opts.treasurySigner - the treasury WalletSigner (backup fee payer)
 * @param {PublicKey[]} [opts.signers]  - additional signers (e.g. new token accounts)
 * @returns {Promise<string>} transaction signature
 */
export async function sendGasless({ instructions, agentSigner, treasurySigner, signers = [] }) {
  const conn       = getConnection();
  const koraReady  = await checkKora();

  if (koraReady && _koraFeePayer) {
    return await sendViaKora({ instructions, agentSigner, signers, conn });
  } else {
    return await sendViaTreasurySponsor({ instructions, agentSigner, treasurySigner, signers, conn });
  }
}

// ── Mode 1: Kora ──────────────────────────────────────────────────────────────

async function sendViaKora({ instructions, agentSigner, signers, conn }) {
  const feePayer = new PublicKey(_koraFeePayer);
  const { blockhash } = await conn.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  await agentSigner.signTransaction(tx);
  for (const s of signers) await s.signTransaction?.(tx);

  const serialized = Buffer.from(tx.serialize()).toString("base64");

  const resp = await fetch(`${KORA_URL}/api/v1/sign_and_send_transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: serialized }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`Kora error: ${resp.status}`);
  const { signature } = await resp.json();
  return signature;
}

// ── Mode 2: Treasury Sponsor (always available) ───────────────────────────────

async function sendViaTreasurySponsor({ instructions, agentSigner, treasurySigner, signers, conn }) {
  // Treasury pays the fee, agent signs the actual instructions
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: treasurySigner.publicKey, // treasury = fee payer
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);

  // Both treasury (feePayer) and agent (authority) must sign
  await treasurySigner.signTransaction(tx);
  await agentSigner.signTransaction(tx);
  for (const s of signers) await s.signTransaction?.(tx);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ── Build a simple SOL transfer instruction (gasless) ─────────────────────────

import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

export function buildSolTransferInstruction(from, to, amountSol) {
  return SystemProgram.transfer({
    fromPubkey: new PublicKey(from),
    toPubkey:   new PublicKey(to),
    lamports:   Math.floor(amountSol * LAMPORTS_PER_SOL),
  });
}

export function getGaslessMode() {
  return _koraAvailable ? "kora" : "treasury_sponsor";
}
