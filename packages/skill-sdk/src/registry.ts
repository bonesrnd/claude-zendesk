import { z } from "zod";

import type {
  RegisteredTool,
  SkillDefinition,
  ToolExecutionContext,
} from "./types";

const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export interface RegisteredToolEntry {
  skill: SkillDefinition;
  tool: RegisteredTool;
}

export class SkillRegistry {
  readonly skills: readonly SkillDefinition[];
  private readonly tools = new Map<string, RegisteredToolEntry>();

  constructor(skills: readonly SkillDefinition[]) {
    const skillIds = new Set<string>();

    for (const skill of skills) {
      IdentifierSchema.parse(skill.id);
      VersionSchema.parse(skill.version);
      if (skillIds.has(skill.id)) {
        throw new Error(`Duplicate skill id ${skill.id}`);
      }
      skillIds.add(skill.id);

      for (const tool of skill.tools) {
        IdentifierSchema.parse(tool.name);
        if (tool.risk === "write" && !tool.requiresConfirmation) {
          throw new Error(`Write tool ${tool.name} must require confirmation`);
        }
        if (this.tools.has(tool.name)) {
          throw new Error(`Duplicate tool name ${tool.name}`);
        }
        this.tools.set(tool.name, { skill, tool });
      }
    }

    this.skills = skills;
  }

  getTool(name: string): RegisteredToolEntry | undefined {
    return this.tools.get(name);
  }

  listTools(): RegisteredToolEntry[] {
    return [...this.tools.values()];
  }

  async executeServerTool(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Unknown tool ${name}`);

    const { tool } = registered;
    if (tool.execution !== "server" || !tool.handler) {
      throw new Error(`Tool ${name} is delegated`);
    }

    return tool.handler(input, context);
  }
}
