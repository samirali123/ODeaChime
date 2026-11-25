import type { ToolCall, ToolResult, ToolSpec } from "../models/types.js";

export type Role = "public" | "student" | "staff" | "admin";
export const ROLE_RANK: Record<Role, number> = { public: 0, student: 1, staff: 2, admin: 3 };

export interface ToolContext {
  role: Role;
  userId: string;
  now: Date;
}

export interface Tool extends ToolSpec {
  /** Lowest role allowed to use this tool. */
  minRole: Role;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Each data source (website, BellForge, calendars, ...) contributes tools here. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
      this.tools.set(t.name, t);
    }
    return this;
  }

  /** Tools visible to a role, in a stable order (keeps the prompt cache warm). */
  specsFor(role: Role): Tool[] {
    return [...this.tools.values()]
      .filter((t) => ROLE_RANK[role] >= ROLE_RANK[t.minRole])
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async runAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    return Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        const tool = this.tools.get(call.name);
        if (!tool || ROLE_RANK[ctx.role] < ROLE_RANK[tool.minRole]) {
          return { callId: call.id, name: call.name, content: `Unknown tool "${call.name}".`, isError: true };
        }
        const input = parseInput(call.input);
        if (!input) {
          return { callId: call.id, name: call.name, content: "Tool input must be a JSON object.", isError: true };
        }
        try {
          return { callId: call.id, name: call.name, content: await tool.run(input, ctx) };
        } catch (err) {
          return { callId: call.id, name: call.name, content: errorText(err), isError: true };
        }
      }),
    );
  }
}

function parseInput(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function stringArg(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`Missing "${key}".`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`"${key}" must be a string.`);
  return v;
}
