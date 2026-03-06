/**
 * src/wallet.js
 *
 * Core wallet operations — used by all skills.
 * Handles: balance, SOL transfer, SPL token transfer (auto-ATA creation),
 * transaction building helpers, and connection management.
 */

import {
  Connection, PublicKey, SystemProgram, Transaction,
  VersionedTransaction, TransactionMessage, AddressLookupTableAccount,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { RPC_URL } from "./config.js";

// ── Connection ────────────────────────────────────────────────────────────────

let _connection = null;

export function getConnection() {
  if (!_connection) _connection = new Connection(RPC_URL, "confirmed");
  return _connection;
}

async function withTimeout(promise, ms, timeoutError = "rpc_timeout") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutError)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function getBalanceSol(pubkey, retries = 3) {
  const conn = getConnection();
  for (let i = 0; i < retries; i++) {
    try {
      const lamports = await withTimeout(
        conn.getBalance(new PublicKey(pubkey), "confirmed"),
        4500,
        "rpc_timeout_get_balance",
      );
      return lamports / LAMPORTS_PER_SOL;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

export async function getTokenBalance(ownerPubkey, mintPubkey) {
  const conn = getConnection();
  const ata  = getAssociatedTokenAddressSync(
    new PublicKey(mintPubkey),
    new PublicKey(ownerPubkey)
  );
  try {
    const info = await withTimeout(
      conn.getTokenAccountBalance(ata),
      4500,
      "rpc_timeout_get_token_balance",
    );
    return {
      amount:   Number(info.value.amount),
      uiAmount: info.value.uiAmount,
      decimals: info.value.decimals,
    };
  } catch {
    return { amount: 0, uiAmount: 0, decimals: 0 };
  }
}

export async function getAllBalances(pubkey) {
  const conn  = getConnection();
  const owner = new PublicKey(pubkey);
  const [sol, tokenAccounts] = await Promise.all([
    getBalanceSol(pubkey).catch(() => 0),
    withTimeout(
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      6000,
      "rpc_timeout_get_parsed_token_accounts",
    ).catch(() => ({ value: [] })),
  ]);

  const tokens = tokenAccounts.value.map(ta => ({
    mint:     ta.account.data.parsed.info.mint,
    amount:   ta.account.data.parsed.info.tokenAmount.amount,
    uiAmount: ta.account.data.parsed.info.tokenAmount.uiAmount,
    decimals: ta.account.data.parsed.info.tokenAmount.decimals,
  })).filter(t => t.uiAmount > 0);

  return { sol, tokens };
}

// ── SOL Transfer ──────────────────────────────────────────────────────────────

export async function transferSol({ signer, toAddress, amountSol }) {
  const conn = getConnection();
  const from = signer.publicKey;
  const to   = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })
  );
  tx.feePayer           = from;
  tx.recentBlockhash    = (await conn.getLatestBlockhash()).blockhash;

  await signer.signTransaction(tx);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// ── SPL Token Transfer (auto-creates ATA if needed) ───────────────────────────

export async function transferSPL({ signer, mintAddress, toAddress, amount }) {
  const conn  = getConnection();
  const mint  = new PublicKey(mintAddress);
  const to    = new PublicKey(toAddress);
  const payer = signer._keypair; // ATA creation needs full keypair for fee payment

  const sourceATA = await getOrCreateAssociatedTokenAccount(conn, payer, mint, signer.publicKey);
  const destATA   = await getOrCreateAssociatedTokenAccount(conn, payer, mint, to);

  const ix = createTransferInstruction(
    sourceATA.address,
    destATA.address,
    signer.publicKey,
    BigInt(amount),
    [],
    TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(ix);
  tx.feePayer        = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  await signer.signTransaction(tx);
  const sim = await simulateTx(tx);
  if (!sim.ok) {
    const firstLog = sim.logs?.[0] ? ` | ${sim.logs[0]}` : "";
    throw new Error(`${sim.error}${firstLog}`);
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return {
    sig,
    simUnitsUsed: sim.unitsConsumed,
    simWarning:   sim.warning ?? null,
  };
}

// ── Versioned Transaction helper ──────────────────────────────────────────────

export async function buildAndSendVersioned({ signer, instructions, lookupTables = [] }) {
  const conn  = getConnection();
  const { blockhash } = await conn.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey:      signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  await signer.signTransaction(tx);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight:       false,
    maxRetries:          3,
    preflightCommitment: "confirmed",
  });

  const { lastValidBlockHeight } = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ── Pre-flight TX simulation ──────────────────────────────────────────────────

/**
 * Simulate a SOL transfer on-chain BEFORE sending.
 * Returns { ok: true } if simulation passes, or { ok: false, error, logs } if it fails.
 * This prevents wasted fees from failed transactions.
 *
 * @param {{ signer, toAddress, amountSol }} opts
 */
export async function simulateTransferSol({ signer, toAddress, amountSol }) {
  const conn = getConnection();
  const from = signer.publicKey;
  const to   = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })
    );
    tx.feePayer        = from;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

    const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });

    if (sim.value.err) {
      return {
        ok:    false,
        error: `simulation_failed: ${JSON.stringify(sim.value.err)}`,
        logs:  sim.value.logs || [],
      };
    }
    return { ok: true, unitsConsumed: sim.value.unitsConsumed };
  } catch (e) {
    // RPC error — don't block execution, just warn
    return { ok: true, warning: `simulation_rpc_error: ${e.message}` };
  }
}

/**
 * Simulate any pre-built Transaction before sending.
 */
export async function simulateTx(tx) {
  const conn = getConnection();
  try {
    if (!tx.recentBlockhash) {
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    }
    const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
    if (sim.value.err) {
      return {
        ok:    false,
        error: `simulation_failed: ${JSON.stringify(sim.value.err)}`,
        logs:  sim.value.logs || [],
      };
    }
    return { ok: true, unitsConsumed: sim.value.unitsConsumed };
  } catch (e) {
    return { ok: true, warning: `simulation_rpc_error: ${e.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function solToLamports(sol) { return Math.floor(sol * LAMPORTS_PER_SOL); }
export function lamportsToSol(l)   { return l / LAMPORTS_PER_SOL; }
export function usdcToUnits(usdc)  { return Math.floor(usdc * 1_000_000); }
export function unitsToUsdc(u)     { return u / 1_000_000; }
