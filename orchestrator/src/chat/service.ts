import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ModelRouter } from "../models/router.js";
import { RouteError } from "../models/router.js";
import { ModelUnavailableError, type ImageMediaType, type ModelProvider, type ProviderSession, type UserPart } from "../models/types.js";
import { ROLE_RANK, type Role, type ToolRegistry } from "../tools/registry.js";
import { runTurn } from "./loop.js";
import { SYSTEM_PROMPT, userPreamble } from "./system-prompt.js";

// The one place a question becomes an answer. Every channel (the web page,
// Microsoft Teams, anything later) calls ChatService.ask(), so they all get
// the same tools, roles, limits and logging.

export interface ChatUser {
  id: string; // e.g. "jane@odea.org", "teams:<aadObjectId>", "anon:<ip>"
  role: Role;
}

export interface AskRequest {
  user: ChatUser;
  channel: "web" | "teams";
  message: string;
  image?: { mediaType: ImageMediaType; data: string };
  /** Web: the id the browser got back last time. Teams: a stable key per Teams chat. */
  conversationId?: string;
  /** Teams keeps one long conversation per chat, so the id must be reusable as-is. */
  conversationKeyIsStable?: boolean;
  localOnly?: boolean;
}

export interface AskResult {
  conversationId: string;
  reply: string;
  toolsUsed: string[];
  model: string;
}

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Conversation {
  id: string;
  userId: string;
  model: ModelProvider;
  session: ProviderSession;
  lastUsed: number;
  busy: boolean;
}

export interface ChatServiceOptions {
  router: ModelRouter;
  registry: ToolRegistry;
  pool?: pg.Pool;
  timeZone: string;
  messagesPerHour: number;
  maxMessageChars: number;
  conversationTtlMinutes: number;
  /** Lowest role allowed to use the assistant at all ("staff" for the staff-only launch). */
  minRole?: Role;
}

export class ChatService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly usage = new Map<string, number[]>();

  constructor(private readonly opts: ChatServiceOptions) {
    setInterval(() => this.expire(), 60_000).unref();
  }

  async ask(req: AskRequest): Promise<AskResult> {
    const { user } = req;
    if (this.opts.minRole && ROLE_RANK[user.role] < ROLE_RANK[this.opts.minRole]) {
      throw new ChatError(403, "ODeaChime is only open to staff right now. It's coming to everyone soon.");
    }
    if (!this.allow(user.id)) throw new ChatError(429, "You've sent a lot of messages. Please wait a bit and try again.");
    const message = req.message.trim();
    if (!message && !req.image) throw new ChatError(400, "Type a message or attach a photo.");
    if (message.length > this.opts.maxMessageChars) throw new ChatError(400, "That message is too long.");

    let convo = req.conversationId ? this.conversations.get(req.conversationId) : undefined;
    if (convo && convo.userId !== user.id) convo = undefined;
    if (convo && req.image && !convo.model.supportsVision) throw new ChatError(400, "Start a new chat to send a photo.");
    const route = { hasImage: !!req.image, localOnly: req.localOnly };
    if (!convo) {
      let model: ModelProvider;
      try {
        model = this.opts.router.pick(route);
      } catch (err) {
        if (err instanceof RouteError) throw new ChatError(400, err.message);
        throw err;
      }
      convo = this.start(req, model);
    }
    if (convo.busy) throw new ChatError(409, "Still working on your last message.");

    const now = new Date();
    const parts: UserPart[] = [];
    if (req.image) parts.push({ type: "image", mediaType: req.image.mediaType, data: req.image.data });
    parts.push({
      type: "text",
      text: `${userPreamble({ now: this.schoolNow(now), role: user.role })}\n\n${message || "What does this photo say?"}`,
    });

    convo.busy = true;
    convo.lastUsed = Date.now();
    try {
      const ctx = { role: user.role, userId: user.id, now };
      let turn;
      try {
        turn = await runTurn(convo.session, this.opts.registry, parts, ctx);
      } catch (err) {
        // The model is down: move to the next model (if allowed) and ask again.
        // The earlier context of this conversation doesn't carry over.
        const next = err instanceof ModelUnavailableError ? this.opts.router.fallbackAfter(convo.model, route) : undefined;
        if (!next) throw err;
        console.warn(`${convo.model.id} unavailable; using ${next.id}`);
        convo.busy = false;
        this.conversations.delete(convo.id);
        convo = this.start(req, next);
        convo.busy = true;
        turn = await runTurn(convo.session, this.opts.registry, parts, ctx);
      }
      this.opts.pool
        ?.query(
          `INSERT INTO chat_log (conversation_id, user_id, role, model, question, had_image, answer, tools_used, stop, input_tokens, output_tokens, channel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [convo.id, user.id, user.role, convo.model.id, message, !!req.image, turn.reply, turn.toolsUsed, turn.stop, turn.usage.inputTokens, turn.usage.outputTokens, req.channel],
        )
        .catch((err) => console.error("chat_log insert failed:", err));
      return { conversationId: convo.id, reply: turn.reply, toolsUsed: [...new Set(turn.toolsUsed)], model: convo.model.id };
    } catch (err) {
      // The provider transcript may now end mid-turn; start fresh next time.
      this.conversations.delete(convo.id);
      throw err;
    } finally {
      convo.busy = false;
    }
  }

  private start(req: AskRequest, model: ModelProvider): Conversation {
    const id = req.conversationKeyIsStable && req.conversationId ? req.conversationId : randomUUID();
    const convo: Conversation = { id, userId: req.user.id, model, session: model.newSession(SYSTEM_PROMPT), lastUsed: Date.now(), busy: false };
    this.conversations.set(id, convo);
    return convo;
  }

  /** Forget a conversation (the user said "new chat"). */
  reset(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  private allow(userId: string): boolean {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (this.usage.get(userId) ?? []).filter((t) => t > hourAgo);
    const ok = recent.length < this.opts.messagesPerHour;
    if (ok) recent.push(Date.now());
    this.usage.set(userId, recent);
    return ok;
  }

  private expire(): void {
    const cutoff = Date.now() - this.opts.conversationTtlMinutes * 60_000;
    for (const [id, c] of this.conversations) if (c.lastUsed < cutoff && !c.busy) this.conversations.delete(id);
  }

  private schoolNow(now: Date): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: this.opts.timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(now);
  }
}
