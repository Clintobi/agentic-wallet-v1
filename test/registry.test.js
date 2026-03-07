/**
 * test/registry.test.js
 *
 * Smoke tests for the skill registry (src/skills/registry.js).
 * Covers: register, getSkill, zodToJsonSchema, and failure classification.
 *
 * Tests avoid calling execute() directly since that path requires live RPC
 * and DB I/O. The registry's core register/lookup API is pure and safe to test.
 *
 * Run with: node --test test/registry.test.js
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { register, getSkill, listSkills, zodToJsonSchema } from "../src/skills/registry.js";

// Import skill files so they self-register before the listSkills tests run.
// Each skill module calls register() on import via src/skills/registry.js.
before(async () => {
  await Promise.all([
    import("../src/skills/balance.js"),
    import("../src/skills/transfer.js"),
    import("../src/skills/jupiter.js"),
  ]);
});

// ── zodToJsonSchema ────────────────────────────────────────────────────────────

describe("zodToJsonSchema", () => {
  it("converts a flat object schema to JSON Schema", () => {
    const schema = z.object({
      toAddress: z.string().describe("Recipient address"),
      amountSol: z.number().describe("Amount in SOL"),
    });
    const json = zodToJsonSchema(schema);

    assert.equal(json.type, "object");
    assert.equal(json.properties.toAddress.type, "string");
    assert.equal(json.properties.toAddress.description, "Recipient address");
    assert.equal(json.properties.amountSol.type, "number");
    assert.deepEqual(json.required, ["toAddress", "amountSol"]);
  });

  it("marks optional fields as non-required", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const json = zodToJsonSchema(schema);

    assert.ok(json.required.includes("required"));
    assert.ok(!json.required.includes("optional"));
  });

  it("handles enum fields", () => {
    const schema = z.object({
      token: z.enum(["SOL", "USDC"]),
    });
    const json = zodToJsonSchema(schema);

    assert.deepEqual(json.properties.token.enum, ["SOL", "USDC"]);
  });

  it("returns empty schema for null input", () => {
    const json = zodToJsonSchema(null);
    assert.equal(json.type, "object");
    assert.deepEqual(json.properties, {});
  });
});

// ── register / getSkill ────────────────────────────────────────────────────────

describe("register and getSkill", () => {
  const TEST_SKILL_NAME = `_test_smoke_${Date.now()}`;

  it("registers a skill and retrieves it by name", () => {
    register({
      name: TEST_SKILL_NAME,
      description: "Smoke test skill",
      inputSchema: z.object({ value: z.number() }),
      async handler({ value }) {
        return { value };
      },
    });

    const skill = getSkill(TEST_SKILL_NAME);
    assert.equal(skill.name, TEST_SKILL_NAME);
    assert.equal(skill.description, "Smoke test skill");
    assert.ok(typeof skill.handler === "function");
  });

  it("throws on duplicate skill registration", () => {
    const duplicateName = `_test_dup_${Date.now()}`;
    register({
      name: duplicateName,
      description: "First registration",
      async handler() { return {}; },
    });

    assert.throws(
      () => register({ name: duplicateName, description: "Second", async handler() {} }),
      /already registered/i,
    );
  });

  it("throws on getSkill for unknown skill", () => {
    assert.throws(
      () => getSkill("__does_not_exist__"),
      /Unknown skill/i,
    );
  });
});

// ── listSkills ─────────────────────────────────────────────────────────────────

describe("listSkills", () => {
  it("returns an array of skill descriptors", () => {
    const skills = listSkills();
    assert.ok(Array.isArray(skills));
    assert.ok(skills.length > 0, "Expected at least one skill registered");
  });

  it("every skill descriptor has name, description, inputSchema", () => {
    const skills = listSkills();
    for (const s of skills) {
      assert.ok(typeof s.name === "string", `${s.name}: name should be string`);
      assert.ok(typeof s.description === "string", `${s.name}: description should be string`);
      assert.ok(typeof s.inputSchema === "object", `${s.name}: inputSchema should be object`);
    }
  });

  it("includes core wallet skills", () => {
    const names = listSkills().map(s => s.name);
    for (const expected of ["get_balance", "transfer_sol", "jupiter_swap"]) {
      assert.ok(names.includes(expected), `Expected skill "${expected}" to be registered`);
    }
  });
});
