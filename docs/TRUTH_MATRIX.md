# Skill Truth Matrix

This file documents the exact execution path of every registered skill.
**No claims are inflated.** If a skill simulates an intent on devnet, it says so here.

## Status Key

| Symbol | Meaning |
|---|---|
| ✅ onchain | Writes a real transaction to Solana devnet/mainnet. Returns a real `sig` + Solscan link. |
| 🔁 intent | Records a protocol intent. On mainnet would broadcast via the protocol SDK. On devnet: simulated with live rate data. |
| 📖 read | Read-only. No transaction or state change. Queries on-chain or external API. |
| 💾 local | Writes to SQLite only. No on-chain component. |
| ⛔ mainnet-only | Requires mainnet liquidity or mainnet-only protocol deployment. On devnet: returns `no_route` or `devnet_unavailable`. |

---

## Wallet Skills

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `get_balance` | RPC `getBalance` on agent wallet | 📖 read | No | Returns agent's own pubkey + SOL balance |
| `get_portfolio` | RPC `getParsedTokenAccounts` | 📖 read | No | SOL + all SPL token balances |
| `get_portfolio_pnl` | SQLite snapshot compare | 📖 read | No | Yield vs first recorded snapshot |

---

## Transfer Skills

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `transfer_sol` | Pre-flight sim → `SystemProgram.transfer` → `sendRawTransaction` → `confirmTransaction` | ✅ onchain | Yes | Policy-gated. Pre-flight simulation blocks insufficient-fund txs before broadcast. |
| `transfer_usdc` | Pre-flight sim → SPL token transfer with auto-ATA creation → `sendRawTransaction` | ✅ onchain | Yes | Creates destination ATA if absent. Requires USDC balance. |

---

## Proof Skill

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `proof_of_execution` | SPL Memo Program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) → `sendRawTransaction` → `confirmTransaction` | ✅ onchain | Yes | **Guaranteed devnet execution path.** Costs ~5,000 lamports (~$0.0001). Never fails as long as signer has any SOL. |

---

## Swap Skills (Jupiter)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `get_sol_price` | Jupiter Price API v2 | 📖 read | No | Falls back to `$0` if API unavailable |
| `get_quote` | Jupiter Quote API v6 (3 endpoints) | 📖 read | No | Never recorded as a tx; preview only |
| `jupiter_swap` | Jupiter Quote + Swap API → `sendRawTransaction` | ⛔ mainnet-only | Yes (mainnet) / No (devnet no_route) | Returns `{ swapped: false, reason: "no_route" }` when devnet liquidity unavailable. Status shown as `no route` in Activity. On mainnet: real swap with sig. |

---

## Lending Skills (MarginFi)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `marginfi_get_rates` | MarginFi API / on-chain bank account | 📖 read | No | Live APY data from MarginFi |
| `marginfi_deposit` | Intent recorded with live rate data | 🔁 intent | No | Devnet: simulated. Mainnet: `@mrgnlabs/marginfi-client-v2` SDK call. Note says "devnet: deposit intent recorded." |
| `marginfi_borrow` | Intent recorded with live rate data | 🔁 intent | No | Same as deposit — devnet intent, mainnet real. |

---

## Staking Skills (Marinade)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `get_stake_rate` | Marinade Finance REST API | 📖 read | No | Live APY + TVL. Fallback to 7.5% if API unavailable. |
| `marinade_stake` | Intent recorded with live APY | 🔁 intent | No | Devnet: mSOL conversion calculated, note says "devnet: stake intent recorded." Mainnet: `@marinade.finance/marinade-ts-sdk`. |
| `marinade_unstake` | Intent recorded | 🔁 intent | No | Devnet: SOL return calculated, note says "devnet: unstake intent." |

---

## Guardian Skills (Security Monitoring)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `guardian_status` | RPC balance + SQLite alert query | 📖 read | No | Returns threat level: ok / warning / critical |
| `get_alerts` | SQLite `alerts` table | 📖 read | No | Filtered by agentId + unacked |
| `ack_alerts` | SQLite update | 💾 local | No | Marks alerts as acknowledged |

---

## Accountant Skills (Balance Tracking)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `get_yield_summary` | SQLite `balance_snapshots` | 📖 read | No | Yield since first snapshot |
| `get_snapshots` | SQLite `balance_snapshots` | 📖 read | No | Historical SOL readings |
| `get_portfolio_pnl` | RPC + SQLite baseline compare | 📖 read | No | Current value vs baseline |

---

## Autopilot Skills (IF/THEN Rules)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `autopilot_create_rule` | SQLite `autopilot_rules` insert | 💾 local | No | Rule stored; evaluated by autopilot heartbeat |
| `autopilot_list_rules` | SQLite select | 📖 read | No | |
| `autopilot_delete_rule` | SQLite delete | 💾 local | No | |
| `autopilot_toggle_rule` | SQLite update | 💾 local | No | |

---

## Payment Skills (Solana Pay)

| Skill | Devnet Path | Onchain? | Sig Returned | Notes |
|---|---|---|---|---|
| `create_payment_request` | SQLite insert + Solana Pay URL generation | 💾 local | No | QR code data and `solana:` URL returned |
| `list_payment_requests` | SQLite select | 📖 read | No | |
| `cancel_payment_request` | SQLite update | 💾 local | No | |
| `check_payment_status` | RPC signature check on `reference` pubkey | 📖 read | No | Polls devnet for confirmed payment |

---

## Summary

| Path | Count | Skills |
|---|---|---|
| ✅ onchain (real sig on devnet) | 3 | `transfer_sol`, `transfer_usdc`, `proof_of_execution` |
| 🔁 intent (devnet sim, mainnet real) | 5 | `marinade_stake`, `marinade_unstake`, `marginfi_deposit`, `marginfi_borrow`, `jupiter_swap` (mainnet-only) |
| 📖 read-only | 16 | `get_balance`, `get_portfolio`, `get_portfolio_pnl`, `get_sol_price`, `get_quote`, `marginfi_get_rates`, `get_stake_rate`, `guardian_status`, `get_alerts`, `get_yield_summary`, `get_snapshots`, `autopilot_list_rules`, `list_payment_requests`, `check_payment_status`, `get_farmer_status`, `get_farmer_activity` |
| 💾 local state | 6 | `ack_alerts`, `autopilot_create_rule`, `autopilot_delete_rule`, `autopilot_toggle_rule`, `create_payment_request`, `cancel_payment_request` |

---

## Production Upgrade Paths

| Skill | Upgrade needed for mainnet |
|---|---|
| `jupiter_swap` | Already implements full quote→swap→send. Needs mainnet SOL + mainnet RPC. |
| `marinade_stake` | Replace intent with `@marinade.finance/marinade-ts-sdk` `marinade.deposit()` call. |
| `marginfi_deposit` | Replace intent with `@mrgnlabs/marginfi-client-v2` bank deposit. |
| `transfer_sol` / `transfer_usdc` | Already mainnet-ready. |
| `proof_of_execution` | Already mainnet-ready (Memo Program is deployed on all clusters). |
