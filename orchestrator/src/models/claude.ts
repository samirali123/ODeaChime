import Anthropic from "@anthropic-ai/sdk";
import {
  ModelUnavailableError,
  type ModelProvider,
  type ProviderSession,
  type StepResult,
  type ToolResult,
  type ToolSpec,
  type UserPart,
} from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeOptions {
  model: string; // e.g. "claude-haiku-5-5"
  effort: Effort;
  maxTokens?: number;
  client?: Anthropic;
}

export class ClaudeProvider implements ModelProvider {
  readonly id: string;
  readonly supportsVision = true;
  private readonly client: Anthropic;

  constructor(private readonly opts: ClaudeOptions) {
    this.id = `claude:${opts.model}`;
    // Credentials come from ANTHROPIC_API_KEY (or an `ant auth login` profile).
    this.client = opts.client ?? new Anthropic();
  }

  newSession(systemPrompt: string): ProviderSession {
    return new ClaudeSession(this.client, this.opts, systemPrompt);
  }
}

class ClaudeSession implements ProviderSession {
  private readonly messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly opts: ClaudeOptions,
    private readonly systemPrompt: string,
  ) {}

  addUser(parts: UserPart[]): void {
    const content: Anthropic.ContentBlockParam[] = parts.map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } },
    );
    this.messages.push({ role: "user", content });
  }

  addToolResults(results: ToolResult[]): void {
    // All results for one assistant turn go back in a single user message.
    const content: Anthropic.ToolResultBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.callId,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    }));
    this.messages.push({ role: "user", content });
  }

  async step(tools: ToolSpec[]): Promise<StepResult> {
    const apiTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    // pause_turn only happens with server tools; loop defensively anyway.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.create(apiTools);

      usage = {
        inputTokens: usage.inputTokens + response.usage.input_tokens,
        outputTokens: usage.outputTokens + response.usage.output_tokens,
        cacheReadTokens: usage.cacheReadTokens + (response.usage.cache_read_input_tokens ?? 0),
      };

      // Keep the assistant turn exactly as returned (thinking blocks included).
      this.messages.push({ role: "assistant", content: response.content });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      switch (response.stop_reason) {
        case "pause_turn":
          continue;
        case "tool_use": {
          const toolCalls = response.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, input: b.input }));
          return { stop: "tools", text, toolCalls, usage };
        }
        case "refusal":
          return { stop: "refused", text, toolCalls: [], usage };
        case "max_tokens":
        case "model_context_window_exceeded":
          return { stop: "truncated", text, toolCalls: [], usage };
        default:
          return { stop: "done", text, toolCalls: [], usage };
      }
    }
    return { stop: "truncated", text: "", toolCalls: [], usage };
  }

  private async create(apiTools: Anthropic.Tool[]): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 16000,
        // Stable prefix first (tools -> system), so the cache keeps hitting.
        system: this.systemPrompt,
        tools: apiTools,
        messages: this.messages,
        output_config: { effort: this.opts.effort },
        // Auto-cache the conversation so each turn only pays for new tokens.
        cache_control: { type: "ephemeral" },
      });
    } catch (err) {
      // Unreachable or overloaded (after the SDK's own retries): let the router try another model.
      if (err instanceof Anthropic.APIConnectionError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)) {
        throw new ModelUnavailableError(`claude:${this.opts.model}`, err);
      }
      throw err;
    }
  }
}
