# Day 3 Target and Judging Map

This document is the source of truth for demo prep and judging alignment.

## End-of-Day 3 Acceptance Criteria

- [x] Core wallet actions are executed on Solana devnet with real signatures and clickable explorer links.
- [x] Safety Runtime is the primary story: pause, freeze, scoped sessions, simulation, firewall, and receipts are all visible.
- [x] Multi-agent independence is real: each agent has its own wallet identity and scope, not one shared treasury actor.
- [x] Demo script and docs map directly to judging rubric categories.
- [x] UI makes execution outcomes explicit (`no_route`, `failed`, `simulated`, `blocked`) with no ambiguous state.

## Rubric-to-Evidence Mapping

| Rubric target | What judge should see live | Evidence pointer |
|---|---|---|
| Devnet on-chain core actions | Action result includes a transaction signature and opens Solscan devnet link | `dashboard/server.js` (`buildReceipt`, `explorerUrl`), `src/skills/transfer.js`, `src/skills/jupiter.js` |
| Safety Runtime as hero | Safety Center controls can pause all agents, freeze one agent, and show risk/session/receipt context | `dashboard/public/index.html` (Safety Center), `dashboard/server.js` (`/api/pause`, `/api/freeze/:agentId`, receipts), `src/policy.js`, `src/firewall.js`, `src/sessions.js` |
| Multi-agent independence | Different agents show different wallet pubkeys and execute under independent identities | `src/agents.js` (`getAgentSigner`, per-agent wallet storage), `src/heartbeat.js` (per-agent signer in `_startAgent`) |
| Docs aligned to rubric | This file + deep dive used as narrated proof map during demo | `docs/DAY3_RUBRIC_MAP.md`, `docs/DEEP_DIVE.md` |
| Explicit status semantics | Activity feed and detail cards show `no route` vs `failed` vs `simulated` vs `blocked` clearly | `dashboard/public/index.html` (`statusTag`, filters), `dashboard/server.js` and `src/heartbeat.js` (`classifyTxStatus`) |

## Demo Sequence (Judge-Facing)

1. Show network badge = `devnet` and run one core action (send or swap path).
2. Open receipt and highlight: status, signature, explorer URL, firewall, and session scope.
3. Trigger a blocked case (policy or firewall) and show explicit `blocked` status.
4. Trigger `no_route` scenario and show explicit `no route` status in Activity.
5. Trigger simulation failure path and show action prevented before submission.
6. Pause runtime globally, verify agents halt, then resume.
7. Freeze one agent, show it is isolated, then unfreeze.
8. Show at least two agents with distinct pubkeys/scopes to prove independent execution identity.
