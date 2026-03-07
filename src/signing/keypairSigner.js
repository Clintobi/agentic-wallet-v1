/**
 * src/signing/keypairSigner.js
 *
 * Local keypair signer — for dev/demo.
 * Implements the WalletSigner interface:
 *   { publicKey, signTransaction, signMessage }
 *
 * To swap to Turnkey or Privy in production, implement the same interface
 * in turnkeySigner.js or privySigner.js and pass it to the skill registry.
 *
 * Key storage: AES-256-GCM encrypted JSON file (wallet.enc.json).
 * Raw private key never logged or exposed to agent runtime.
 *
 * Blob format: salt(32) | iv(12) | authTag(16) | ciphertext
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Keypair, VersionedTransaction, Transaction } from "@solana/web3.js";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 32 };

// ── Encryption helpers ────────────────────────────────────────────────────────

function encryptKey(secretKeyArray, passphrase) {
  const salt = crypto.randomBytes(32);
  const key  = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
  const iv   = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(secretKeyArray));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag  = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
  return blob.toString("base64");
}

function decryptKey(encrypted, passphrase) {
  const blob     = Buffer.from(encrypted, "base64");
  const salt     = blob.subarray(0,  32);
  const iv       = blob.subarray(32, 44);
  const authTag  = blob.subarray(44, 60);
  const ciphertext = blob.subarray(60);
  const key      = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString());
}

function requirePassphrase(passphrase = process.env.WALLET_PASSPHRASE) {
  if (!passphrase) {
    throw new Error("WALLET_PASSPHRASE env var is required. Set it in .env");
  }
  return passphrase;
}

export function saveEncryptedKeypair(encPath, keypair, passphrase = process.env.WALLET_PASSPHRASE) {
  const resolvedPassphrase = requirePassphrase(passphrase);
  fs.mkdirSync(path.dirname(encPath), { recursive: true });
  const encrypted = encryptKey(Array.from(keypair.secretKey), resolvedPassphrase);
  fs.writeFileSync(encPath, JSON.stringify({ encrypted, version: 1 }, null, 2));
}

export function loadEncryptedKeypair(encPath, passphrase = process.env.WALLET_PASSPHRASE) {
  const resolvedPassphrase = requirePassphrase(passphrase);
  if (!fs.existsSync(encPath)) return null;
  const { encrypted } = JSON.parse(fs.readFileSync(encPath, "utf-8"));
  const secretArr = decryptKey(encrypted, resolvedPassphrase);
  return Keypair.fromSecretKey(Uint8Array.from(secretArr));
}

// ── Load or create wallet ─────────────────────────────────────────────────────

export function loadOrCreateKeypair(encPath) {
  const passphrase = requirePassphrase();

  const existing = loadEncryptedKeypair(encPath, passphrase);
  if (existing) return existing;

  const kp        = Keypair.generate();
  saveEncryptedKeypair(encPath, kp, passphrase);
  console.log(`[signer] New wallet created: ${kp.publicKey.toBase58()}`);
  console.log(`[signer] Encrypted at: ${encPath}`);
  return kp;
}

// ── WalletSigner interface ────────────────────────────────────────────────────

export function createKeypairSigner(keypair) {
  return {
    publicKey: keypair.publicKey,

    /** Signs a VersionedTransaction or legacy Transaction in-place */
    async signTransaction(tx) {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },

    /** Signs a raw message buffer, returns Uint8Array signature */
    async signMessage(message) {
      return keypair.sign(message).signature;
    },

    /** Expose keypair for sendRawTransaction flows */
    _keypair: keypair,
  };
}
