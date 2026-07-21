import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineSkill, defineTool, SkillRegistry } from "./index";

const Input = z.strictObject({ id: z.string() });
const Output = z.strictObject({ ok: z.boolean() });

function readTool(name: string) {
  return defineTool({
    name,
    description: "Read a record",
    risk: "read",
    requiresConfirmation: false,
    execution: "delegated",
    inputSchema: Input,
    outputSchema: Output,
  });
}

describe("SkillRegistry", () => {
  it("rejects confirmed writes without a typed proposal factory", () => {
    const unsafe = defineSkill({
      id: "unsafe_proposal",
      name: "Unsafe proposal",
      version: "1.0.0",
      instructions: "Unsafe proposal test skill",
      credentials: [],
      tools: [
        defineTool({
          name: "missing_proposal",
          description: "Mutates a record",
          risk: "write",
          requiresConfirmation: true,
          execution: "delegated",
          inputSchema: Input,
          outputSchema: Output,
        }),
      ],
    });

    expect(() => new SkillRegistry([unsafe])).toThrow(
      "Write tool missing_proposal requires a proposal factory",
    );
  });

  it("rejects write tools without confirmation", () => {
    const unsafe = defineSkill({
      id: "unsafe",
      name: "Unsafe",
      version: "1.0.0",
      instructions: "Unsafe test skill",
      credentials: [],
      tools: [
        defineTool({
          name: "unsafe_write",
          description: "Mutates a record",
          risk: "write",
          requiresConfirmation: false,
          execution: "server",
          inputSchema: Input,
          outputSchema: Output,
          async handler() {
            return { ok: true };
          },
        }),
      ],
    });

    expect(() => new SkillRegistry([unsafe])).toThrow(
      "Write tool unsafe_write must require confirmation",
    );
  });

  it("rejects duplicate global tool names", () => {
    const makeSkill = (id: string) =>
      defineSkill({
        id,
        name: id,
        version: "1.0.0",
        instructions: id,
        credentials: [],
        tools: [readTool("duplicate_tool")],
      });

    expect(() => new SkillRegistry([makeSkill("a"), makeSkill("b")])).toThrow(
      "Duplicate tool name duplicate_tool",
    );
  });

  it("rejects duplicate skill identifiers", () => {
    const skill = defineSkill({
      id: "same",
      name: "Same",
      version: "1.0.0",
      instructions: "Same",
      credentials: [],
      tools: [readTool("same_read")],
    });

    expect(() => new SkillRegistry([skill, skill])).toThrow(
      "Duplicate skill id same",
    );
  });

  it("validates server input and output", async () => {
    const skill = defineSkill({
      id: "server",
      name: "Server",
      version: "1.0.0",
      instructions: "Server",
      credentials: [],
      tools: [
        defineTool({
          name: "server_read",
          description: "Read a server record",
          risk: "read",
          requiresConfirmation: false,
          execution: "server",
          inputSchema: Input,
          outputSchema: Output,
          async handler(input) {
            return { ok: input.id === "expected" };
          },
        }),
      ],
    });
    const registry = new SkillRegistry([skill]);

    await expect(
      registry.executeServerTool(
        "server_read",
        { id: "expected", extra: true },
        {
          signal: new AbortController().signal,
          credentials: {},
          tenantKey: "tenant",
          ticketId: 8421,
        },
      ),
    ).rejects.toThrow();
  });
});

describe("defineTool", () => {
  it("preserves a typed write proposal factory", () => {
    const tool = defineTool({
      name: "confirmed_write",
      description: "Mutates a record after confirmation",
      risk: "write",
      requiresConfirmation: true,
      execution: "delegated",
      inputSchema: Input,
      outputSchema: Output,
      createProposal(input) {
        return {
          action: "zendesk_update_customer_profile",
          targetId: 77,
          before: { name: "Before" },
          changes: { name: input.id },
          recordVersion: "version-1",
        };
      },
    });

    expect(tool.createProposal?.({ id: "After" })).toMatchObject({
      action: "zendesk_update_customer_profile",
      changes: { name: "After" },
    });
  });

  it("requires a handler for server tools", () => {
    expect(() =>
      defineTool({
        name: "missing_handler",
        description: "Invalid server tool",
        risk: "read",
        requiresConfirmation: false,
        execution: "server",
        inputSchema: Input,
        outputSchema: Output,
      }),
    ).toThrow("Server tool missing_handler requires a handler");
  });

  it("forbids handlers on delegated tools", () => {
    expect(() =>
      defineTool({
        name: "delegated_handler",
        description: "Invalid delegated tool",
        risk: "read",
        requiresConfirmation: false,
        execution: "delegated",
        inputSchema: Input,
        outputSchema: Output,
        async handler() {
          return { ok: true };
        },
      }),
    ).toThrow("Delegated tool delegated_handler cannot define a handler");
  });
});
