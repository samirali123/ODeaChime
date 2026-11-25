// Provider-neutral model interface.
//
// Each provider keeps its own transcript in its own wire format (a
// ProviderSession), because Claude requires its assistant turns to be sent
// back exactly as returned. The chat loop only ever talks to this interface,
// so swapping Claude for a local model is a config change.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: "object"). */
  inputSchema: Record<string, unknown>;
}

export type UserPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; data: string /* base64 */ };

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type StepStop =
  | "done" // the model finished its answer
  | "tools" // the model wants tool results before continuing
  | "refused" // the model declined (safety)
  | "truncated"; // hit the output limit

export interface StepResult {
  stop: StepStop;
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

export interface ProviderSession {
  addUser(parts: UserPart[]): void;
  step(tools: ToolSpec[]): Promise<StepResult>;
  addToolResults(results: ToolResult[]): void;
}

export interface ModelProvider {
  /** e.g. "claude:claude-haiku-5-5" or "ollama:qwen3-vl:8b" */
  readonly id: string;
  readonly supportsVision: boolean;
  newSession(systemPrompt: string): ProviderSession;
}

/** The model couldn't be reached or is overloaded; another model may be tried. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly modelId: string,
    readonly cause?: unknown,
  ) {
    super(`${modelId} is unavailable`);
  }
}
