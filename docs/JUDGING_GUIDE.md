# Judging Guide — Solana Agent Wallet

**For the Superteam Nigeria DeFi Developer Challenge**

This guide maps every likely judging criterion to the exact file, endpoint, or UI action that demonstrates it. Designed for a 6-minute live review.

---

## Quick Start for Judges

```bash
git clone https://github.com/Clintobi/solana-agent-wallet.git
cd solana-agent-wallet
npm install
cp .env.example .env
# Edit .env — set WALLET_PASSPHRASE to any string

WALLET_PASSPHRASE=contest2025 npm start
# Open http://localhost:3000
```

**No external accounts. No API keys. No mainnet funds.**

Optional setup check:
```bash
node scripts/setup.js   # Validates Node.js version, .env, data dir
WALLET_PASSPHRASE=test npm test  # 109 tests, 0 failures
```

---

## Rubric Evidence Map

### 1. On-Chain Core Actions (Real Devnet Transactions)

**What judges should see:**
- Action result includes `sig` field (base58 transaction signature)
- `explorer` field opens Solscan devnet link
- Transaction is visible on Solscan at `?cluster=devnet`

**How to verify:**
1. Open **Skills** tab → execute `transfer_sol` (0.001 SOL to any address)
2. Result JSON: `{ "sig": "4xBCK...", "explorer": "https://solscan.io/tx/...?cluster=devnet" }`
3. Click the explorer link — transaction is live on devnet

**Real on-chain paths (always produce signatures):**
- `transfer_sol` → `src/skills/transfer.js:transferSol()`
- `transfer_usdc` → `src/skills/transfer.js:transferUsdc()` (requires USDC balance)
- `proof_of_execution` → SPL Memo Program — **guaranteed path**, costs ~5,000 lamports

**Code pointers:**
- `src/skills/transfer.js` — `sendRawTransaction` + `confirmTransaction`
- `dashboard/server.js` — `buildReceipt()`, `explorerUrl()`
- `src/skills/proof.js` — SPL Memo on-chain path

---

### 2. Safety Runtime (Hero Feature)

**Claim:** Every agent action passes through an 11-check ordered policy gate before signing. First failure blocks immediately.

**11 Checks (in order):**

| # | Check | Config key | Demo trigger |
|---|---|---|---|
| 0 | Emergency pause | `emergencyPause` | Safety Center → Pause All |
| 1 | Agent frozen | `frozenAgents[]` | Agents tab → Freeze `sable` |
| 2 | Agent scope | `agentScopes{}` | Remove skill from scope → execute → scope_violation |
| 3 | Reserve floor | `reserveSol` | Set reserve > balance → execute → reserve_floor |
| 4 | Per-tx limit | `maxPerTxSol` | Send 5 SOL → per_tx_limit |
| 5 | Daily rolling limit | `dailyLimitSol` | Set low daily limit → exceed → daily_limit |
| 5a | Velocity auto-freeze | `velocityFreezeSol` | Two rapid transfers → auto-freeze |
| 6 | Program allowlist | `allowedPrograms[]` | Execute with unlisted program → program_allowlist |
| 7 | Destination allowlist | `allowedDestinations[]` | Send to unlisted address → destination_allowlist |
| 8 | Cooldown | `cooldownSeconds` | Rapid-fire same skill → cooldown |
| 9 | Human approval gate | `approvalThresholdSol` | Large tx → human_approval_required |

**How to verify:**
- All values live in `policy.json` — hot-reloadable via `POST /api/policy` (no restart)
- Blocked response format: `{ "ok": false, "blocked": true, "reason": "per_tx_limit: 5.0 > 0.5" }`

**Code pointers:**
- `src/policy.js` — `evaluatePolicy()` (11 ordered checks)
- `dashboard/server.js` — `POST /api/pause`, `POST /api/resume`, `POST /api/freeze/:agentId`
- `src/firewall.js` — `evaluateFirewall()` (risk score 0–100, structured block reasons)
- `src/sessions.js` — `validateSessionForExecution()` (TTL, skill allowlist, amount cap, destination allowlist)

---

### 3. Multi-Agent Independence

**Claim:** Nine agents, each with its own AES-256-GCM encrypted keypair, policy scope, spend tracking, and key rotation history.

**How to verify:**
1. Open **Agents** tab
2. Click two different agents — each shows a **different public key**
3. One agent frozen ≠ another agent frozen (surgical isolation)
4. Key rotation: `POST /api/agents/:id/rotate-key` — each agent's key can be rotated independently

**Agent roster:**

| Agent | Role | Interval |
|---|---|---|
| `sable` | Bear trader | 30s |
| `nova` | Bull trader | 30s |
| `axiom` | LP sentinel | 60s |
| `crest` | Yield farmer | 120s |
| `pilot` | Autopilot | 60s |
| `harvest` | Airdrop farmer | 45s |
| `ledger` | Accountant | 120s |
| `shield` | Guardian | 20s |
| `pay` | Social wallet | 300s |

**Code pointers:**
- `src/agents.js` — `getAgentSigner()`, `provisionAgent()`, `rotateAgentKey()`, `getKeyHistory()`
- `src/heartbeat.js` — per-agent signer injection in `_startAgent()`
- `data/agent-wallets/` — per-agent encrypted keypair files

---

### 4. Pre-Flight Simulation

**Claim:** Fund-moving actions are simulated on-chain before broadcast. If simulation fails, no transaction is sent.

**How to verify:**
1. Execute `transfer_sol` with amount > wallet balance
2. Policy check runs first (per_tx_limit)
3. If policy passes: `simulateTransaction` runs on Solana devnet
4. If simulation fails: `{ "ok": false, "simFailed": true, "reason": "simulation_failed: ...", "logs": [...] }`
5. No `sig` in response. Nothing was broadcast.

**Code pointers:**
- `src/skills/transfer.js` — `simulateTransferSol()` called before `sendRawTransaction`
- `src/skills/jupiter.js` — `connection.simulateTransaction()` before swap broadcast

---

### 5. Idempotency Keys (Replay Attack Prevention)

**Claim:** Value-moving skills enforce 24h idempotency keys. Duplicate requests return cached result without re-executing.

**How to verify (API):**
```bash
# First call
curl -X POST http://localhost:3000/api/skill \
  -H "Content-Type: application/json" \
  -d '{"skill":"transfer_sol","params":{"toAddress":"11111111111111111111111111111111","amountSol":0.001},"agentId":"nova","idempotencyKey":"demo-key-123"}'

# Second call with same key — returns cached result, no new tx
curl -X POST http://localhost:3000/api/skill \
  -H "Content-Type: application/json" \
  -d '{"skill":"transfer_sol","params":{"toAddress":"11111111111111111111111111111111","amountSol":0.001},"agentId":"nova","idempotencyKey":"demo-key-123"}'
# Response includes: "idempotencyHit": true, "cachedAt": ...
```

**Code pointers:**
- `src/idempotency.js` — `checkIdempotency()`, `recordIdempotency()`, `IDEMPOTENT_SKILLS`
- `dashboard/server.js` — idempotency check before `execute()` in `/api/skill`

---

### 6. Scoped Sessions

**Claim:** Sessions enforce TTL, skill allowlist, per-tx amount cap, and destination allowlist at execution time.

**How to verify (API):**
```bash
# Issue a session for nova, limited to transfer_sol, max 0.01 SOL, 5-minute TTL
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"scopeSubject":"nova","ttlSeconds":300,"allowedSkills":["transfer_sol"],"maxPerTxSol":0.01}'

# Use session — allowed
curl -X POST http://localhost:3000/api/skill \
  -H "Content-Type: application/json" \
  -d '{"skill":"transfer_sol","params":{"toAddress":"11111111111111111111111111111111","amountSol":0.005},"agentId":"nova","sessionId":"<id>"}'

# Session blocked — skill not in allowlist
curl -X POST http://localhost:3000/api/skill \
  -H "Content-Type: application/json" \
  -d '{"skill":"jupiter_swap","params":{},"agentId":"nova","sessionId":"<id>"}'
# Response: { "blocked": true, "reason": "skill_not_allowed" }
```

**Code pointers:**
- `src/sessions.js` — `issueSession()`, `validateSessionForExecution()`
- `dashboard/server.js` — `POST /api/sessions`, session validation in `/api/skill`

---

### 7. Transaction Receipts (Audit Trail)

**Claim:** Every execution produces a signed receipt (JSON + shareable HTML).

**How to verify:**
```bash
# Get receipt for any transaction
curl http://localhost:3000/api/txs/<txId>/receipt

# HTML receipt (shareable)
open http://localhost:3000/api/txs/<txId>/receipt.html
```

**Receipt includes:** skill, agent, status, amount, signature, addresses, reason/error, timestamp, explorer URL.

**Code pointers:**
- `dashboard/server.js` — `GET /api/txs/:txId/receipt`, `GET /api/txs/:txId/receipt.html`, `buildReceipt()`

---

### 8. Key Management

**Claim:** Per-agent AES-256-GCM encrypted keypairs with audit-logged key rotation.

**Encryption scheme:**
```
scrypt(passphrase, salt, N=16384, r=8, p=1) → 32-byte key
AES-256-GCM(key, iv, plaintext=secretKey) → ciphertext + authTag
Blob on disk: salt(32) | iv(12) | authTag(16) | ciphertext(32)
```

**Key rotation:**
```bash
# Rotate signing key for agent nova
curl -X POST http://localhost:3000/api/agents/nova/rotate-key \
  -H "Content-Type: application/json" \
  -d '{"reason":"demo_rotation"}'

# View rotation history
curl http://localhost:3000/api/agents/nova/key-history
```

**Code pointers:**
- `src/agents.js` — `provisionAgent()`, `rotateAgentKey()`, `getKeyHistory()`
- `src/db.js` — `agent_key_versions` table
- `data/agent-wallets/` — per-agent `.enc.json` files

---

### 9. Error Classification and Retry

**Claim:** 12 classified error codes divided into retryable and fatal. Retryable errors use exponential backoff with jitter.

**Error codes:**
- **Retryable:** `rpc_timeout`, `blockhash_expired`, `connection_error`, `rate_limited`
- **Fatal:** `simulation_failed`, `no_route`, `slippage_exceeded`, `price_impact_too_high`, `policy_blocked`, `firewall_blocked`, `insufficient_funds`, `unknown_error`

**Code pointers:**
- `src/retry.js` — `classifyError()`, `withRetry()`
- `dashboard/server.js` — error response includes `errorCode` and `retryable` fields

---

### 10. MCP Server (AI Agent Integration)

**Claim:** Claude and other MCP clients can call any registered skill with the same 11-check policy gate.

**How to verify:**
1. Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "solana-wallet": {
      "command": "node",
      "args": ["/absolute/path/to/solana-agent-wallet/mcp/server.js"],
      "env": { "WALLET_PASSPHRASE": "contest2025", "SOLANA_NETWORK": "devnet" }
    }
  }
}
```
2. In Claude: *"What's my SOL balance?"* or *"Send 0.001 SOL to 11111...1"*
3. Same policy gate applies — no AI bypass.

**Code pointers:**
- `mcp/server.js` — MCP tool definitions
- Tool dispatch routes through `execute()` in `src/skills/registry.js` (same as dashboard)

---

## Test Suite

```bash
WALLET_PASSPHRASE=test npm test
```

- **109 tests, 0 failures**
- Covers: policy engine, skill registry, wallet helpers, session validation, firewall scoring, idempotency, retry logic
- Test files: `test/policy.test.js`, `test/sessions.test.js`, `test/firewall.test.js`, `test/idempotency.test.js`, `test/retry.test.js`, `test/wallet.test.js`, `test/registry.test.js`

---

## File Structure Reference

```
src/
  agents.js           — per-agent wallet management, key rotation
  policy.js           — 11-check policy engine
  firewall.js         — risk scoring and structured block reasons
  sessions.js         — scoped session issue/validate/revoke
  idempotency.js      — 24h idempotency enforcement
  retry.js            — error classification and backoff
  heartbeat.js        — autonomous agent runtime (9 agents)
  db.js               — SQLite schema and queries
  skills/
    registry.js       — execution gateway (schema → policy → handler)
    transfer.js       — transfer_sol, transfer_usdc (real on-chain)
    jupiter.js        — jupiter_swap, get_quote, get_sol_price
    marginfi.js       — marginfi_get_rates, deposit, borrow
    marinade.js       — marinade_stake/unstake, get_stake_rate
    proof.js          — proof_of_execution (SPL Memo, guaranteed on-chain)
    guardian.js       — guardian_status, get_alerts, ack_alerts
    analytics.js      — balance_snapshot, yield_summary, PnL
    autopilot.js      — IF/THEN rule engine
    payments.js       — Solana Pay payment requests
dashboard/
  server.js           — REST + SSE control plane
  public/index.html   — single-file dashboard UI
mcp/
  server.js           — MCP tool server for Claude Desktop
docs/
  DEEP_DIVE.md        — architecture, threat model, key management
  TRUTH_MATRIX.md     — exact execution path per skill (real vs simulated)
  DEMO_SCRIPT.md      — 6-minute live demo walkthrough
  JUDGING_GUIDE.md    — this file
SKILLS.md             — full skill catalog with schemas and risk classes
policy.json           — hot-reloadable policy configuration
```
