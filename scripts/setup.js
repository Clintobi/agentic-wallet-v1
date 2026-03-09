#!/usr/bin/env node
/**
 * scripts/setup.js
 *
 * One-time setup helper for Solana Agent Wallet.
 * Run: node scripts/setup.js
 *
 * What it does:
 *   1. Checks Node.js version (>= 20 required)
 *   2. Creates .env from .env.example if missing
 *   3. Validates WALLET_PASSPHRASE is set
 *   4. Confirms data directory exists
 *   5. Prints next-step instructions
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir  = path.dirname(fileURLToPath(import.meta.url));
const root   = path.join(__dir, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW= "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";

function ok(msg)   { console.log(`${GREEN}  ✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠${RESET} ${msg}`); }
function err(msg)  { console.log(`${RED}  ✗${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}  →${RESET} ${msg}`); }

console.log();
console.log(`${BOLD}Solana Agent Wallet — Setup${RESET}`);
console.log("─".repeat(48));

// ── 1. Node.js version check ──────────────────────────────────────────────────
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  err(`Node.js >= 20 required. You have ${process.version}.`);
  err("  Install: https://nodejs.org or use: nvm install 20");
  process.exit(1);
}
ok(`Node.js ${process.version}`);

// ── 2. Create .env if missing ─────────────────────────────────────────────────
if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    warn(".env created from .env.example — edit WALLET_PASSPHRASE before continuing.");
  } else {
    err(".env.example not found. Cannot create .env.");
    process.exit(1);
  }
} else {
  ok(".env exists");
}

// ── 3. Validate WALLET_PASSPHRASE ─────────────────────────────────────────────
// Read .env manually (don't use dotenv to avoid importing issues)
const envContent = fs.readFileSync(envPath, "utf-8");
const passMatch = envContent.match(/^WALLET_PASSPHRASE\s*=\s*(.+)$/m);
const passphrase = passMatch?.[1]?.trim();

if (!passphrase || passphrase === "your-strong-passphrase-here") {
  warn("WALLET_PASSPHRASE is not set in .env.");
  warn('  Edit .env and set:  WALLET_PASSPHRASE=your-secure-phrase');
  warn("  The wallet encrypts your signing key with this passphrase.");
  warn("  Any string works — longer is more secure.");
} else {
  ok(`WALLET_PASSPHRASE set (${passphrase.length} chars)`);
}

// ── 4. Data directory ─────────────────────────────────────────────────────────
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
ok(`data/ directory ready`);

// ── 5. Done ───────────────────────────────────────────────────────────────────
console.log();
console.log(`${BOLD}Setup complete. Start the dashboard:${RESET}`);
console.log();
info("WALLET_PASSPHRASE=<your-phrase> npm start");
console.log();
console.log("  Dashboard: http://localhost:3000");
console.log("  MCP server (Claude Desktop): npm run mcp");
console.log("  Tests: npm test");
console.log();
console.log("For judges: see docs/JUDGING_GUIDE.md for the demo walkthrough.");
console.log();
