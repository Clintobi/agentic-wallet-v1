/**
 * src/skills/memo.js
 *
 * Skills: proof_of_execution
 *
 * Writes a timestamped on-chain Memo to Solana devnet.
 * This is the guaranteed onchain proof path:
 *   - Uses the Solana Memo Program (SPL-Memo v2)
 *   - Costs ~5,000 lamports (≈ $0.0001) per call
 *   - Always succeeds as long as the signer wallet has any SOL
 *   - Returns a real transaction signature + Solscan devnet link
 *
 * Memo Program ID: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
 */

import { z } from "zod";
import { Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { register } from "./registry.js";
import { getConnection } from "../wallet.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function explorerUrl(sig) {
  const cluster = process.env.SOLANA_NETWORK === "mainnet-beta" ? "" : "?cluster=devnet";
  return `https://solscan.io/tx/${sig}${cluster}`;
}

register({
  name: "proof_of_execution",
  description:
    "Write a timestamped on-chain Memo to Solana. Produces a real devnet transaction signature — guaranteed onchain proof that this wallet executed an action at a specific time. Uses the SPL Memo program (costs ~5,000 lamports).",
  inputSchema: z.object({
    message: z
      .string()
      .max(100)
      .optional()
      .describe("Optional message to commit on-chain (max 100 chars). Defaults to a timestamp proof."),
  }),
  async handler({ message }, { signer, agentId }) {
    const conn = getConnection();
    const text = message || `solana-agent-wallet:proof:${agentId || "treasury"}:${Date.now()}`;

    const ix = new TransactionInstruction({
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(text, "utf-8"),
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = signer.publicKey;
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    await signer.signTransaction(tx);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");

    return {
      sig,
      message: text,
      program:  "spl_memo_v2",
      explorer: explorerUrl(sig),
      confirmed: true,
    };
  },
});
