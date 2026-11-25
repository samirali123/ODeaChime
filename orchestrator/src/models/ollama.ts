import { randomUUID } from "node:crypto";
import {
  ModelUnavailableError,
  type ModelProvider,
  type ProviderSession,
  type StepResult,
  type ToolResult,
  type ToolSpec,
  type UserPart,
} from "./types.js";

// Local models through Ollama's /api/chat (tool calling + images).
// https://github.com/ollama/ollama/blob/main/docs/api.md

export interface OllamaOptions {
  baseUrl: string; // e.g. http://ollama:11434
  model: string; // e.g. qwen3-vl:8b
  supportsVision: boolean;
  fetchImpl?: typeof fetch;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly supportsVision: boolean;

  constructor(private readonly opts: OllamaOptions) {
    this.id = `ollama:${opts.model}`;
    this.supportsVision = opts.supportsVision;
  }

  newSession(systemPrompt: string): ProviderSession {
    return new OllamaSession(this.opts, systemPrompt);
  }
}

class OllamaSession implements ProviderSession {
  private readonly messages: OllamaMessage[];

  constructor(
    private readonly opts: OllamaOptions,
    systemPrompt: string,
  ) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  addUser(parts: UserPart[]): void {
    const text = parts
      .filter((p): p is Extract<UserPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const images = parts
      .filter((p): p is Extract<UserPart, { type: "image" }> => p.type === "image")
      .map((p) => p.data);
    this.messages.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_name: r.name,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }

  async step(tools: ToolSpec[]): Promise<StepResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const id = `ollama:${this.opts.model}`;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        messages: this.messages,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
      });
    } catch (err) {
      throw new ModelUnavailableError(id, err);
    }
    if (res.status >= 500) throw new ModelUnavailableError(id, new Error(`Ollama answered ${res.status}: ${await res.text()}`));
    if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      message: OllamaMessage;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const msg = body.message;
    this.messages.push(msg);
    const usage = { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 };

    const calls = msg.tool_calls ?? [];
    if (calls.length) {
      return {
        stop: "tools",
        text: msg.content ?? "",
        // Ollama doesn't assign call ids; results are matched by order and name.
        toolCalls: calls.map((c) => ({ id: randomUUID(), name: c.function.name, input: c.function.arguments })),
        usage,
      };
    }
    return { stop: body.done_reason === "length" ? "truncated" : "done", text: msg.content ?? "", toolCalls: [], usage };
  }
}
