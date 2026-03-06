/**
 * mcp/server.js
 *
 * Solana Agent Wallet — MCP Server
 *
 * Exposes all wallet skills as MCP tools compatible with:
 *   - Claude Desktop
 *   - Claude Code
 *   - Any MCP-compatible agent framework
 *
 * Run:  node mcp/server.js
 * Add to Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "solana-wallet": {
 *         "command": "node",
 *         "args": ["/path/to/solana-agent-wallet/mcp/server.js"],
 *         "env": { "WALLET_PASSPHRASE": "your-passphrase" }
 *       }
 *     }
 *   }
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Load all skills (side-effect: registers them in the registry)
import "../src/skills/balance.js";
import "../src/skills/transfer.js";
import "../src/skills/jupiter.js";
import "../src/skills/marginfi.js";
import "../src/skills/marinade.js";

import { listSkills, execute, zodToJsonSchema } from "../src/skills/registry.js";
import { loadPolicy, getPolicy, getPendingApprovals } from "../src/policy.js";
import { loadOrCreateKeypair, createKeypairSigner } from "../src/signing/keypairSigner.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = path.join(__dir, "../wallet.enc.json");
const POLICY_PATH = path.join(__dir, "../policy.json");

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadPolicy(POLICY_PATH);
const keypair = loadOrCreateKeypair(WALLET_PATH);
const signer  = createKeypairSigner(keypair);
const agentId = "mcp-agent";

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "solana-agent-wallet",
  version: "1.0.0",
});

// Register every skill in the registry as an MCP tool
const skills = listSkills();
for (const skill of skills) {
  server.tool(
    skill.name,
    skill.description,
    skill.inputSchema.properties ?? {},
    async (params) => {
      const idempotencyKey = typeof params?.idempotencyKey === "string"
        ? params.idempotencyKey
        : null;
      const sessionId = typeof params?.sessionId === "string"
        ? params.sessionId
        : null;
      const sessionProof = typeof params?.sessionProof === "string"
        ? params.sessionProof
        : null;
      const agentRole = typeof params?.agentRole === "string"
        ? params.agentRole
        : null;
      const result = await execute(skill.name, params, {
        signer,
        agentId,
        idempotencyKey,
        sessionId,
        sessionProof,
        agentRole,
      });

      const text = result.blocked
        ? `❌ Blocked by policy: ${result.reason}`
        : result.ok
          ? JSON.stringify(result, null, 2)
          : `❌ Error: ${result.error}${result.detail ? "\n" + JSON.stringify(result.detail) : ""}`;

      return { content: [{ type: "text", text }] };
    }
  );
}

// Resource: wallet state (balance + address + policy)
server.resource(
  "wallet://state",
  "Current wallet state: address, SOL balance, active policy",
  async (uri) => {
    const { getBalanceSol } = await import("../src/wallet.js");
    const sol    = await getBalanceSol(signer.publicKey.toBase58()).catch(() => null);
    const policy = getPolicy();
    return {
      contents: [{
        uri:      uri.href,
        mimeType: "application/json",
        text:     JSON.stringify({ address: signer.publicKey.toBase58(), sol, policy }, null, 2),
      }],
    };
  }
);

// Resource: pending human approvals
server.resource(
  "wallet://approvals",
  "Pending actions awaiting human approval",
  async (uri) => {
    const pending = getPendingApprovals();
    return {
      contents: [{
        uri:      uri.href,
        mimeType: "application/json",
        text:     JSON.stringify(pending, null, 2),
      }],
    };
  }
);

// Resource: available skills list
server.resource(
  "wallet://skills",
  "All available wallet skills with descriptions and input schemas",
  async (uri) => {
    return {
      contents: [{
        uri:      uri.href,
        mimeType: "application/json",
        text:     JSON.stringify(skills, null, 2),
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// MCP stdio server — no console.log after this point (stdout is the MCP channel)
