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
- `agent-can-use`: callable by autonomous agents, MCP, and dashboard skill execution endpoint.
- `agent-can-use (read)`: no on-chain fund movement by design.
- `agent-can-use (fund-moving)`: may move funds and therefore can trigger policy checks.
- `owner-control`: not a skill; dashboard/system endpoints such as pause/resume/freeze.

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

## Notes
- Skill count in current repo evidence: 29.
- Pre-flight simulation is explicitly implemented for:
  - `transfer_sol`
  - `transfer_usdc`
  - `jupiter_swap`
- Transaction receipts are available via:
  - `GET /api/txs/:txId/receipt`
  - `GET /api/txs/:txId/receipt.html`
