# Solana Agent Wallet

A production-grade agentic wallet for Solana — built to the same standard as Coinbase AgentKit, awal, and Privy server wallets, but native to Solana.

**Agents can: Send · Receive · Swap · Lend · Stake · Monitor**

---

## Architecture

```
LLM (Claude / GPT / any MCP client)
  ↓ MCP tool calls
┌─────────────────────────────────────┐
│         Wallet MCP Server           │
│  ┌──────────────────────────────┐   │
│  │       Skill Registry         │   │
│  │  transfer_sol   get_balance  │   │
│  │  jupiter_swap   get_quote    │   │
│  │  marginfi_*     marinade_*   │   │
│  └──────────┬───────────────────┘   │
│  ┌──────────▼───────────────────┐   │
│  │       Policy Engine          │   │
│  │  reserve · per-tx · daily    │   │
│  │  cooldown · program-allowlist│   │
│  │  destination · human-gate   │   │
│  └──────────┬───────────────────┘   │
│  ┌──────────▼───────────────────┐   │
│  │      Signing Layer           │   │
│  │  Keypair (dev) │ Turnkey     │   │
│  │  Privy (prod)  │ Lit Protocol│   │
│  └──────────┬───────────────────┘   │
└────────────┼────────────────────────┘
             ↓ Solana RPC (Helius)
  Jupiter · Marginfi · Marinade · SPL
```

---

## Quick Start

```bash
git clone <repo>
cd solana-agent-wallet
npm install
cp .env.example .env
# Edit .env: set WALLET_PASSPHRASE

# Start dashboard
npm run dashboard
# Open http://localhost:3000

# Or: MCP server (for Claude Desktop)
npm run mcp
```

---

## Skills

| Skill | Description |
|---|---|
| `get_balance` | SOL balance |
| `get_portfolio` | All token balances |
| `transfer_sol` | Send SOL (policy-gated) |
| `transfer_usdc` | Send USDC (auto-creates ATA) |
| `jupiter_swap` | Swap any token pair (best route) |
| `get_quote` | Preview swap without executing |
| `get_sol_price` | Live SOL/USD price |
| `marginfi_get_rates` | Lending APY for SOL/USDC |
| `marginfi_deposit` | Deposit into Marginfi |
| `marginfi_borrow` | Borrow from Marginfi |
| `get_stake_rate` | Marinade staking APY |
| `marinade_stake` | Liquid-stake SOL → mSOL |
| `marinade_unstake` | Unstake mSOL → SOL |

For the full protocol-style skill spec (schemas, access levels, policy triggers), see [`SKILLS.md`](./SKILLS.md).

For a security-focused architecture write-up, see [`docs/DEEP_DIVE.md`](./docs/DEEP_DIVE.md).

---

## Policy Engine

All actions pass through 7 checks before signing:

1. **Reserve floor** — wallet keeps ≥ N SOL always
2. **Per-tx limit** — max SOL per single action
3. **Daily rolling limit** — 24h total cap per agent
4. **Program allowlist** — only approved on-chain programs
5. **Destination allowlist** — only approved recipients
6. **Cooldown** — min seconds between actions
7. **Human approval gate** — actions above threshold pause for human sign-off

Edit `policy.json` or use the dashboard to tune live.

---

## MCP Server (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "solana-wallet": {
      "command": "node",
      "args": ["/path/to/solana-agent-wallet/mcp/server.js"],
      "env": {
        "WALLET_PASSPHRASE": "your-passphrase",
        "SOLANA_NETWORK": "devnet"
      }
    }
  }
}
```

Then in Claude: *"What's my SOL balance?"* or *"Swap 0.1 SOL to USDC"*

---

## Adding New Skills

```js
// src/skills/myprotocol.js
import { z } from "zod";
import { register } from "./registry.js";

register({
  name:        "my_action",
  description: "Does something useful on Solana",
  inputSchema: z.object({
    amountSol: z.number().describe("Amount in SOL"),
  }),
  async handler({ amountSol }, { signer, agentId }) {
    // ... build tx, sign, send
    return { sig, amountSol };
  },
});
```

Import it in `src/agent.js`, `mcp/server.js`, and `dashboard/server.js`. Done.

---

## Upgrading the Signing Layer

The signing layer is swappable. To use Turnkey in production:

```js
// src/signing/turnkeySigner.js
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";

export function createTurnkeySigner(walletAddress) {
  const client = new Turnkey({ ... });
  return {
    publicKey: new PublicKey(walletAddress),
    async signTransaction(tx) { /* use TurnkeySigner */ },
    async signMessage(msg)    { /* use TurnkeySigner */ },
  };
}
```

Pass to `runAgents({ signer: createTurnkeySigner(...) })`. Everything else stays the same.

---

## Contest: Superteam Nigeria DeFi Developer Challenge
Built for the $5,000 USDG prize pool. Industry-standard architecture inspired by:
- **awal** (Coinbase) — skill module pattern, human-controlled spend limits
- **CDP AgentKit** — action provider plugin system, human-in-the-loop hooks
- **Privy server wallets** — delegation model, swappable signing layer
- **Solana Agent Kit** — Solana-native DeFi integrations
