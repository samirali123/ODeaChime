import type { ProviderSession, StepResult, UserPart } from "../models/types.js";
import type { ToolContext, ToolRegistry } from "../tools/registry.js";

export interface TurnResult {
  reply: string;
  toolsUsed: string[];
  stop: StepResult["stop"] | "tool_limit";
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

const REFUSAL_REPLY =
  "Sorry, I can't help with that one. If it's about O'Dea, try asking another way, or contact the front office.";
const TOOL_LIMIT_REPLY =
  "I couldn't find a clear answer to that. Please check odea.org or contact the front office.";

/** One user turn: let the model call tools until it answers (bounded). */
export async function runTurn(
  session: ProviderSession,
  registry: ToolRegistry,
  parts: UserPart[],
  ctx: ToolContext,
  maxToolRounds = 6,
): Promise<TurnResult> {
  const tools = registry.specsFor(ctx.role);
  const toolsUsed: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  session.addUser(parts);

  for (let round = 0; round <= maxToolRounds; round++) {
    const step = await session.step(tools);
    usage.inputTokens += step.usage?.inputTokens ?? 0;
    usage.outputTokens += step.usage?.outputTokens ?? 0;
    usage.cacheReadTokens += step.usage?.cacheReadTokens ?? 0;

    if (step.stop === "refused") return { reply: REFUSAL_REPLY, toolsUsed, stop: "refused", usage };
    if (step.stop !== "tools") {
      const reply = step.text.trim() || TOOL_LIMIT_REPLY;
      return { reply, toolsUsed, stop: step.stop, usage };
    }
    if (round === maxToolRounds) break;

    toolsUsed.push(...step.toolCalls.map((c) => c.name));
    const results = await registry.runAll(step.toolCalls, ctx);
    session.addToolResults(results);
  }
  return { reply: TOOL_LIMIT_REPLY, toolsUsed, stop: "tool_limit", usage };
}
