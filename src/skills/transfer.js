/**
 * src/skills/transfer.js
 *
 * Skills: transfer_sol, transfer_spl
 */

import { z } from "zod";
import { register } from "./registry.js";
import { transferSol, transferSPL, simulateTransferSol, usdcToUnits } from "../wallet.js";
import { MINTS } from "../config.js";

register({
  name:        "transfer_sol",
  description: "Transfer SOL to any Solana address. Pre-flight simulated before sending. Policy-gated: per-tx, daily, reserve, and cooldown limits.",
  inputSchema: z.object({
    toAddress: z.string().describe("Recipient Solana public key (base58)"),
    amountSol: z.number().describe("Amount of SOL to send"),
  }),
  programs: [],
  async handler({ toAddress, amountSol }, { signer }) {
    // ── Pre-flight simulation ─────────────────────────────────────────────────
    const sim = await simulateTransferSol({ signer, toAddress, amountSol });
    if (!sim.ok) {
      return {
        ok:        false,
        blocked:   true,
        reason:    sim.error,
        simFailed: true,
        logs:      sim.logs,
      };
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    const sig = await transferSol({ signer, toAddress, amountSol });
    return {
      sig,
      amountSol,
      toAddress,
      explorer:       explorerUrl(sig),
      simUnitsUsed:   sim.unitsConsumed,
    };
  },
});

register({
  name:        "transfer_usdc",
  description: "Transfer USDC to any Solana address. Auto-creates destination ATA if needed and runs pre-flight simulation before send.",
  inputSchema: z.object({
    toAddress:  z.string().describe("Recipient Solana public key (base58)"),
    amountUsdc: z.number().describe("Amount of USDC to send (human-readable, e.g. 10.5 = $10.50)"),
  }),
  programs: [MINTS.USDC],
  async handler({ toAddress, amountUsdc }, { signer }) {
    const amount                  = usdcToUnits(amountUsdc);
    const { sig, simUnitsUsed }   = await transferSPL({ signer, mintAddress: MINTS.USDC, toAddress, amount });
    return { sig, amountUsdc, toAddress, explorer: explorerUrl(sig), simUnitsUsed };
  },
});

function explorerUrl(sig) {
  const cluster = process.env.SOLANA_NETWORK === "mainnet-beta" ? "" : "?cluster=devnet";
  return `https://solscan.io/tx/${sig}${cluster}`;
}
