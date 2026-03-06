/**
 * src/actions.js
 *
 * Solana Actions + Blinks endpoint handlers.
 *
 * Exposes the wallet as Blinks — anyone can paste a link into
 * a Blinks-aware app (Phantom, dialect.to, Twitter/X) and interact
 * with your agent wallet directly.
 *
 * Actions exposed:
 *   GET/POST /actions/send          — send SOL to agent wallet
 *   GET/POST /actions/swap          — trigger a Jupiter swap
 *   GET/POST /actions/stake         — liquid stake SOL via Marinade
 *   GET/POST /actions/fund-agent/:name — fund a specific named agent
 *
 * Blink URL format:
 *   https://dial.to/?action=solana-action:https://your-host.com/actions/send
 *
 * Spec: https://docs.dialect.to/documentation/actions
 */

import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { getConnection } from "./wallet.js";
import { getAllAgents, getAgent } from "./agents.js";

// Required CORS headers for the Actions spec
export function actionsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
  res.setHeader("X-Action-Version", "2.1.3");
  res.setHeader("X-Blockchain-Ids", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
}

function explorerUrl(sig) {
  const cluster = process.env.SOLANA_NETWORK === "mainnet-beta" ? "" : "?cluster=devnet";
  return `https://solscan.io/tx/${sig}${cluster}`;
}

// ── Action: Fund Agent ────────────────────────────────────────────────────────

export function getActionMeta(req, res, treasuryPubkey) {
  actionsHeaders(res);
  const agents = getAllAgents();
  res.json({
    icon:        `${req.protocol}://${req.get("host")}/icon.png`,
    title:       "Solana Agent Wallet",
    description: "Fund an AI agent or trigger autonomous DeFi actions on Solana.",
    label:       "Fund Agent",
    links: {
      actions: [
        {
          label:  "Fund Treasury (0.1 SOL)",
          href:   `/actions/fund?amount=0.1`,
        },
        {
          label:  "Fund Treasury (0.5 SOL)",
          href:   `/actions/fund?amount=0.5`,
        },
        {
          label:  "Custom Amount",
          href:   `/actions/fund?amount={amount}`,
          parameters: [{ name: "amount", label: "SOL amount", required: true }],
        },
        ...agents.slice(0, 3).map(a => ({
          label: `Fund Agent: ${a.name}`,
          href:  `/actions/fund-agent/${a.name}?amount=0.1`,
        })),
      ],
    },
  });
}

export async function postActionFund(req, res, treasuryPubkey) {
  actionsHeaders(res);
  try {
    const { account } = req.body;
    const amount      = parseFloat(req.query.amount ?? 0.1);

    if (!account) return res.status(400).json({ message: "account required" });
    if (amount <= 0 || amount > 10) return res.status(400).json({ message: "amount must be 0.01–10 SOL" });

    const conn       = getConnection();
    const payer      = new PublicKey(account);
    const treasury   = new PublicKey(treasuryPubkey);
    const lamports   = Math.floor(amount * LAMPORTS_PER_SOL);

    const { blockhash } = await conn.getLatestBlockhash();
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury, lamports });
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const serialized = Buffer.from(tx.serialize()).toString("base64");

    res.json({
      transaction: serialized,
      message:     `Funding agent wallet with ${amount} SOL. Thank you!`,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function postActionFundAgent(req, res) {
  actionsHeaders(res);
  try {
    const { account } = req.body;
    const { name }    = req.params;
    const amount      = parseFloat(req.query.amount ?? 0.1);
    const agent       = getAgent(name);

    if (!agent) return res.status(404).json({ message: `Agent "${name}" not found` });
    if (!account) return res.status(400).json({ message: "account required" });

    const conn     = getConnection();
    const payer    = new PublicKey(account);
    const agentKey = new PublicKey(agent.pubkey);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    const { blockhash } = await conn.getLatestBlockhash();
    const ix  = SystemProgram.transfer({ fromPubkey: payer, toPubkey: agentKey, lamports });
    const msg = new TransactionMessage({
      payerKey: payer, recentBlockhash: blockhash, instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);

    res.json({
      transaction: Buffer.from(tx.serialize()).toString("base64"),
      message:     `Sending ${amount} SOL to agent "${name}" (${agent.role})`,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── OPTIONS preflight ─────────────────────────────────────────────────────────

export function handleOptions(req, res) {
  actionsHeaders(res);
  res.status(204).end();
}
