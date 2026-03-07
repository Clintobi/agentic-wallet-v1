# SKILLS.md

Version: 1.0
Project: Solana Agent Wallet

## Purpose
This file specifies the wallet skills exposed by the registry in `src/skills/registry.js` and loaded by:
- `mcp/server.js` (MCP tools)
- `dashboard/server.js` (`POST /api/skill`)
- `src/heartbeat.js` (autonomous agent execution)

## Runtime Contract
- Execution entrypoint: `execute(skillName, params, context)` from `src/skills/registry.js`.
- Context contract: `context = { signer, agentId, ... }`.
- Validation path:
  - Skills with `inputSchema` use Zod validation.
  - Skills without `inputSchema` accept free-form params (legacy style using `params` metadata).
- Policy path:
  - Scope allowlists are enforced for all skills using `agentName` (or `agentId` fallback).
  - Spend/limit policy evaluation is applied when `amountSol` or `amountUsdc` is present and greater than 0.
  - Policy source: `policy.json` + in-memory updates via `POST /api/policy`.

## Access Levels

| Level | Description |
|---|---|
| `agent-can-use (read)` | Safe for any agent at any time. No on-chain fund movement. No policy spend checks triggered. |
| `agent-can-use` | Callable by any agent. Writes to local state (DB rules, alerts) but does not move funds on-chain. |
| `agent-can-use (fund-moving)` | Moves real funds on-chain. Pre-flight simulated before broadcast. Full 11-check policy gate runs on `amountSol`/`amountUsdc`. Requires agent to be in scope, unfrozen, and within spend limits. |
| `agent-can-use (fund-moving intent)` | Intent is recorded and protocol interaction is initiated, but devnet execution is simulated (no live on-chain spend). Same policy checks apply. Production deployment would execute the real transaction. |
| `agent-can-use (read/intentional)` | Primarily a read operation, but initiates a state-changing intent (e.g. unstake request). No direct spend trigger; separate confirmation flow handles on-chain execution. |
| `owner-control` | Not a skill. Privileged dashboard/API endpoints (`/api/pause`, `/api/resume`, `/api/freeze/:id`, `/api/policy`). Not routed through the skill registry. |

## Policy Checks Triggered (fund-moving requests)
When amount > 0, skill execution may be blocked by `src/policy.js` checks:
1. `emergency_pause`
2. `agent_frozen`
3. `agent_scope`
4. `reserve_floor`
5. `per_tx_limit`
6. `daily_limit`
7. `velocity_freeze`
8. `program_allowlist`
9. `destination_allowlist`
10. `cooldown`
11. `human_approval_gate`

Scope allowlist (`agent_scope`) is checked for all skill executions.

## Skill Catalog

| Skill | Input Schema | Output Schema (summary) | Access Level | Policy Trigger |
|---|---|---|---|---|
| `get_balance` | `{}` | `{ sol, address, fetchedAt }` | `agent-can-use (read)` | `none` |
| `get_portfolio` | `{}` | `{ address, sol, tokens[], fetchedAt }` | `agent-can-use (read)` | `none` |
| `transfer_sol` | `{ toAddress: string, amountSol: number }` | success: `{ sig, amountSol, toAddress, explorer, simUnitsUsed }`; sim fail: `{ ok:false, blocked:true, reason, simFailed, logs }` | `agent-can-use (fund-moving)` | `amountSol` |
| `transfer_usdc` | `{ toAddress: string, amountUsdc: number }` | `{ sig, amountUsdc, toAddress, explorer, simUnitsUsed }` | `agent-can-use (fund-moving)` | `amountUsdc` |
| `jupiter_swap` | `{ inputMint: string, outputMint: string, amountSol: number, slippageBps?: number }` | route miss: `{ swapped:false, reason }`; success: `{ swapped:true, sig, simUnitsUsed, inputAmount, outputAmount, priceImpactPct, route, explorer }` | `agent-can-use (fund-moving)` | `amountSol` |
| `get_sol_price` | `{}` | `{ price, source, fetchedAt }` | `agent-can-use (read)` | `none` |
| `get_quote` | `{ inputMint: string, outputMint: string, amountSol: number, slippageBps?: number }` | `{ available, outputAmount?, priceImpactPct?, route?, reason? }` | `agent-can-use (read)` | `amountSol` |
| `marginfi_get_rates` | `{ token: "SOL"\|"USDC" }` | `{ token, mint, depositApy, borrowApy, source, liquidity? }` | `agent-can-use (read)` | `none` |
| `marginfi_deposit` | `{ token: "SOL"\|"USDC", amountSol: number }` | `{ deposited:true, protocol, token, amountSol, depositApy, projectedYearlyReturn, note }` | `agent-can-use (fund-moving intent)` | `amountSol` |
| `marginfi_borrow` | `{ token: "SOL"\|"USDC", amountSol: number }` | `{ borrowed:true, protocol, token, amountSol, borrowApy, projectedInterestPerYear, note }` | `agent-can-use (fund-moving intent)` | `amountSol` |
| `get_stake_rate` | `{}` | `{ protocol, stakingToken, apy, tvlSol, source, fetchedAt }` | `agent-can-use (read)` | `none` |
| `marinade_stake` | `{ amountSol: number }` | `{ staked:true, solStaked, mSolReceived, stakingApy, projectedYearlyReturn, note }` | `agent-can-use (fund-moving intent)` | `amountSol` |
| `marinade_unstake` | `{ amountMsol: number, instant?: boolean }` | `{ unstaked:true, mSolUnstaked, solReceived, method, waitTime, note }` | `agent-can-use (read/intentional)` | `none` |
| `get_alerts` | legacy params (`agentId?`) | `{ ok, alerts[] }` | `agent-can-use (read)` | `none` |
| `ack_alerts` | legacy params (`agentId`) | `{ ok, acked }` | `agent-can-use` | `none` |
| `guardian_status` | legacy params (`{}`) | `{ ok, price, balance, unackedAlerts, critical, warnings, threatLevel }` | `agent-can-use (read)` | `none` |
| `get_yield_summary` | legacy params (`agentId, limit?`) | `{ ok, first, last, yieldSol, yieldUsd, yieldPct, snapCount, sparkline[] }` | `agent-can-use (read)` | `none` |
| `get_snapshots` | legacy params (`agentId, limit`) | `{ ok, snaps[] }` | `agent-can-use (read)` | `none` |
| `get_portfolio_pnl` | legacy params (`{}`) | `{ ok, totalYieldUsd, breakdown[] }` | `agent-can-use (read)` | `none` |
| `autopilot_create_rule` | legacy params (`agentId, name, condition, action`) | `{ ok, rule }` | `agent-can-use` | `none` |
| `autopilot_list_rules` | legacy params (`agentId?`) | `{ ok, rules[] }` | `agent-can-use (read)` | `none` |
| `autopilot_delete_rule` | legacy params (`ruleId`) | `{ ok, deleted }` | `agent-can-use` | `none` |
| `autopilot_toggle_rule` | legacy params (`ruleId, enabled`) | `{ ok, ruleId, enabled }` | `agent-can-use` | `none` |
| `get_farmer_status` | legacy params (`agentId`) | `{ ok, protocols[], activityScore, maxScore }` | `agent-can-use (read)` | `none` |
| `get_farmer_activity` | legacy params (`agentId, limit?`) | `{ ok, activity[] }` | `agent-can-use (read)` | `none` |
| `create_payment_request` | legacy params (`agentId, label, memo?, amountSol?, recipient?`) | `{ ok, payReqId, recipient, reference, solanaPay, blinkUrl, qrData }` | `agent-can-use` | `none` |
| `list_payment_requests` | legacy params (`agentId?, status?`) | `{ ok, requests[] }` | `agent-can-use (read)` | `none` |
| `cancel_payment_request` | legacy params (`payReqId`) | `{ ok, cancelled }` | `agent-can-use` | `none` |
| `check_payment_status` | legacy params (`payReqId`) | `{ ok, payReqId, status, paidSig?, paidAt?, solanaPay }` | `agent-can-use (read)` | `none` |

## Owner-Control (Non-Skill) Endpoints
These are not skill calls and should be treated as privileged controls:
- `POST /api/pause`
- `POST /api/resume`
- `POST /api/freeze/:agentId`
- `POST /api/unfreeze/:agentId`
- `POST /api/policy`

## Example Calls & Responses

### 1. `get_balance` — read-only, no policy check

**Request (MCP tool call / POST /api/skill):**
```json
{ "skill": "get_balance", "params": {}, "agentId": "ledger" }
```

**Response:**
```json
{
  "ok": true,
  "sol": 1.4889,
  "address": "8fdbGA8j5z6sds2sbZfdLzeyUcQmExwCxmQuVxehdFNB",
  "fetchedAt": 1741305600000
}
```

---

### 2. `transfer_sol` — fund-moving, pre-flight simulated, full policy gate

**Request:**
```json
{
  "skill": "transfer_sol",
  "params": { "toAddress": "So11111111111111111111111111111111111111112", "amountSol": 0.05 },
  "agentId": "alpha"
}
```

**Response (success):**
```json
{
  "sig": "5Yz3...abc",
  "amountSol": 0.05,
  "toAddress": "So11111111111111111111111111111111111111112",
  "explorer": "https://solscan.io/tx/5Yz3...abc?cluster=devnet",
  "simUnitsUsed": 450
}
```

**Response (blocked by policy — daily limit):**
```json
{
  "ok": false,
  "blocked": true,
  "reason": "daily_limit: spent=1.9500+0.0500>2.0000"
}
```

**Response (blocked by pre-flight simulation — insufficient funds):**
```json
{
  "ok": false,
  "blocked": true,
  "simFailed": true,
  "reason": "simulation_failed: {\"InsufficientFundsForRent\":{\"account_index\":0}}",
  "logs": ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports ..."]
}
```

---

### 3. `autopilot_create_rule` — state-writing, no spend

**Request:**
```json
{
  "skill": "autopilot_create_rule",
  "params": {
    "agentId": "pilot",
    "name": "Stake when cheap",
    "condition": "price < 150",
    "action": "marinade_stake 0.1"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "rule": {
    "id": "rule_7f3a2c",
    "agentId": "pilot",
    "name": "Stake when cheap",
    "condition": "price < 150",
    "action": "marinade_stake 0.1",
    "enabled": true,
    "createdAt": 1741305600000
  }
}
```

---

## Notes
- **Skill count:** 29 registered skills across 9 categories.
- **Pre-flight simulation** is implemented for `transfer_sol`, `transfer_usdc`, and `jupiter_swap`. Simulation failure returns `{ ok: false, simFailed: true }` — no transaction is broadcast.
- **Transaction receipts** are available after any fund-moving skill executes:
  - JSON: `GET /api/txs/:txId/receipt`
  - HTML (shareable): `GET /api/txs/:txId/receipt.html`
- **Scope enforcement** applies to every skill call, including read-only skills. An agent not listed in `policy.json → agentScopes[agentId]` cannot call a skill even if it has no spend impact.
