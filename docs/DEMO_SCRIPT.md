# Demo Script — Solana Agent Wallet
## 6-Minute Live Demo

**Goal:** Show judges a working, safety-controlled multi-agent wallet in under 6 minutes.
**Network:** Solana devnet (no mainnet funds needed)
**One command to start:**
```bash
WALLET_PASSPHRASE=contest2025 npm start
# → http://localhost:3000
```

---

## Setup Checklist (before demo)

- [ ] `npm start` running, browser at `http://localhost:3000`
- [ ] Devnet badge visible in header (not mainnet)
- [ ] At least 3 agents in Agents tab with distinct pubkeys
- [ ] Activity feed has recent entries (heartbeat is running)

---

## Segment 1 — Orienting (0:00 – 0:45)

**Narrator:** "This is Solana Agent Wallet. Nine independent agents run autonomously on Solana devnet. Each has its own encrypted keypair, its own role, and its own policy scope. The owner controls all of them from this dashboard without writing code."

**UI actions:**
1. Point to the **header** — network badge shows `devnet`, balance displayed.
2. Click **Agents** tab — show list of agents: `sable`, `nova`, `axiom`, `crest`, `pilot`, `harvest`, `ledger`, `shield`, `pay`.
3. Point to two different agents — show **different pubkeys** under each agent card.
4. Click **Activity** tab — show the live feed updating every few seconds.

**Key point:** Multi-agent independence. Different wallets, different identities, different scopes. Not one shared treasury actor.

---

## Segment 2 — Real Devnet Transaction (0:45 – 1:30)

**Narrator:** "Let me show a real on-chain action. We'll execute a SOL transfer and get a receipt with a real Solana signature."

**UI actions:**
1. Click **Skills** tab (or use the manual executor in Safety Center).
2. Select skill: `transfer_sol`, agent: `nova`, `toAddress`: any devnet address (e.g. `11111111111111111111111111111111`), `amountSol`: `0.001`.
3. Click **Execute**.
4. Result appears: `sig: 4xBCK...`, green `confirmed` badge, and an **Solscan link**.
5. Click the Solscan link — browser opens `https://solscan.io/tx/...?cluster=devnet`.

**Key point:** Real signature, real on-chain transaction, clickable proof.

---

## Segment 3 — Policy Block (1:30 – 2:15)

**Narrator:** "Now I'll show the safety runtime in action. The policy engine has 11 ordered checks. Let's trigger a block."

**UI actions:**
1. Execute `transfer_sol` again for `nova`, this time `amountSol`: `5.0` (exceeds `maxPerTxSol`).
2. Result returns immediately: red `blocked` badge, reason: `per_tx_limit: 5.0 > 0.5`.
3. Point to the reason string — **no transaction was broadcast**.

**Optional second block — daily limit:**
- Alternatively, set a low `dailyLimitSol` via **Policy** tab (`nova.dailyLimitSol: 0.001`), then execute a `0.002` transfer.
- Shows `daily_limit: spent=0.001+0.002>0.001`.

**Key point:** First failure blocks immediately. Funds were never touched.

---

## Segment 4 — Pre-Flight Simulation Gate (2:15 – 2:45)

**Narrator:** "Before any fund-moving transaction is broadcast, it's pre-flight simulated on-chain. If simulation fails, nothing goes out."

**UI actions:**
1. Execute `transfer_sol` with `amountSol` larger than the wallet's actual balance (e.g. `999`).
2. Policy blocks first (`per_tx_limit`). Lower the limit via Policy.
3. Re-execute — simulation catches it: `simFailed: true`, reason: `InsufficientFundsForRent`.
4. Show the logs in the result — direct from Solana RPC simulation.

**Key point:** Two-layer protection. Policy blocks by rule. Simulation blocks by reality.

---

## Segment 5 — Emergency Pause + Resume (2:45 – 3:30)

**Narrator:** "Emergency pause is the global kill switch. One click stops all nine agents instantly."

**UI actions:**
1. Click **Safety Center** tab.
2. Find the **Emergency Pause** control — click **Pause All Agents**.
3. Switch to **Activity** tab — live feed stops updating (agents are halted).
4. Try to execute any skill manually — response: `{ blocked: true, reason: "emergency_pause" }`.
5. Return to Safety Center — click **Resume**.
6. Activity feed resumes within a few seconds.

**Key point:** Instant reversible kill switch. No restart needed.

---

## Segment 6 — Per-Agent Freeze (3:30 – 4:00)

**Narrator:** "The freeze is surgical. You can isolate one agent without touching the others."

**UI actions:**
1. In **Agents** tab, find `sable`.
2. Click **Freeze** button on `sable`'s card.
3. `sable` card shows frozen badge (red/orange).
4. Execute any skill as `sable` — returns `{ blocked: true, reason: "agent_frozen" }`.
5. Execute the same skill as `nova` — succeeds normally.
6. Click **Unfreeze** on `sable` — agent resumes.

**Key point:** One frozen, eight running. Surgical isolation.

---

## Segment 7 — Transaction Receipt (4:00 – 4:45)

**Narrator:** "Every execution — success, blocked, or failed — produces a signed receipt. This is the audit trail."

**UI actions:**
1. Click **Activity** tab.
2. Click any completed transaction row.
3. Detail panel opens — shows: skill, agent, status, timestamp, amount, signature.
4. Click **View Receipt** or navigate to `GET /api/txs/:txId/receipt`.
5. Show JSON receipt in browser.
6. Navigate to `GET /api/txs/:txId/receipt.html` — show the shareable HTML receipt.

**Key point:** Every action is logged, receipted, and shareable. Forensic trail from day one.

---

## Segment 8 — Velocity Auto-Freeze (4:45 – 5:15)

**Narrator:** "If an agent spends too much in one minute, it auto-freezes. No human needed to catch it."

**UI actions:**
1. Set `velocityFreezeSol` low via **Policy** tab (e.g. `0.002`).
2. Execute two transfers quickly through `nova` totaling > `0.002 SOL` within 60 seconds.
3. On the second attempt — response: `{ blocked: true, reason: "velocity_freeze:... agent auto-frozen" }`.
4. `nova` card shows frozen badge automatically.
5. Show that this happened without any manual intervention.

**Key point:** Autonomous self-protection. Spike detected, agent quarantined.

---

## Segment 9 — MCP Integration (5:15 – 5:45)

**Narrator:** "Claude and other AI clients connect via MCP. The same 11-check policy applies regardless of where the request comes from."

**UI actions:**
1. Show `mcp/server.js` briefly in editor — or show the config snippet from README.
2. Explain: any AI client that calls `transfer_sol` via MCP goes through the exact same skill registry → policy → simulation chain.
3. No separate trust boundary. No "AI bypass".

**Key point:** Uniform execution path. MCP is just another caller.

---

## Segment 10 — Wrap (5:45 – 6:00)

**Narrator:** "This is Solana Agent Wallet. Nine autonomous agents, each with its own encrypted keypair, executing real on-chain actions through a production-grade safety runtime with pause, freeze, simulation, firewall, idempotency, and audit receipts — all on Solana devnet, one command to run."

**Final show:**
1. Activity feed running live.
2. Network badge: `devnet`.
3. Balance: still intact (safety controls worked).

---

## Fallback Notes

**If Jupiter returns `no_route` on devnet (expected):**
- Activity shows `no route` status — this is documented behavior.
- Use `transfer_sol` or `proof_of_execution` as the real on-chain demo path instead.
- `proof_of_execution` always works (SPL Memo, costs ~5,000 lamports).

**If devnet RPC is slow:**
- `transfer_sol` may take 10–30 seconds to confirm.
- Show the pending state in Activity — live SSE update when it confirms.

**If balance is low:**
- Run `solana airdrop 1 <pubkey> --url devnet` from terminal.
- Wallet address: `8fdbGA8j5z6sds2sbZfdLzeyUcQmExwCxmQuVxehdFNB`.

---

## Timing Summary

| Segment | Duration | What |
|---|---|---|
| 1. Orient | 0:45 | Multi-agent, distinct pubkeys, live feed |
| 2. Real tx | 0:45 | transfer_sol → sig → Solscan |
| 3. Policy block | 0:45 | per_tx_limit or daily_limit blocked |
| 4. Simulation gate | 0:30 | simFailed before broadcast |
| 5. Emergency pause | 0:45 | Kill all → verify → resume |
| 6. Per-agent freeze | 0:30 | Freeze one, run another |
| 7. Receipt | 0:45 | JSON + HTML audit trail |
| 8. Velocity freeze | 0:30 | Auto-freeze on spend spike |
| 9. MCP path | 0:30 | Same policy, any AI client |
| 10. Wrap | 0:15 | Summary |
| **Total** | **6:00** | |
