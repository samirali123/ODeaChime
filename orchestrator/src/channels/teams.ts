// Microsoft Teams channel.
//
// People message the assistant in Teams (a 1:1 chat, or @mention it in a
// team channel or group chat). Azure Bot Service forwards each message to
// POST /api/messages here; we answer through the same ChatService the web
// page uses. Setup: docs/TEAMS.md.
//
// Built on the Microsoft 365 Agents SDK (@microsoft/agents-hosting), the
// successor to the Bot Framework SDK.

import type http from "node:http";
import {
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  type AuthConfiguration,
  type TurnContext,
  type WebResponse,
} from "@microsoft/agents-hosting";
import { ChatError, type ChatService, type ChatUser } from "../chat/service.js";
import type { Role } from "../tools/registry.js";

export interface TeamsOptions {
  /** Only people in the school's Microsoft 365 tenant may use the bot. */
  tenantId: string;
  defaultRole: Role;
  /** Entra ID group object ids whose members get the staff / student role. */
  staffGroupIds: string[];
  studentGroupIds: string[];
  maxBodyBytes: number;
}

const WELCOME =
  "Hi! I'm ODeaChime. Ask me about bell schedules, events, athletics, policies and more. " +
  'Try "What schedule is today?" Type "new chat" to start over.';
const PHOTO_NOTE = "I can't read photos sent in Teams yet. Open the ODeaChime web page to ask about a photo.";

export class TeamsChannel {
  private readonly authConfig: AuthConfiguration;
  private readonly adapter: CloudAdapter;
  private readonly roles: GraphRoleResolver;

  constructor(
    private readonly chat: ChatService,
    private readonly opts: TeamsOptions,
  ) {
    // Reads clientId, clientSecret and tenantId from the environment.
    this.authConfig = loadAuthConfigFromEnv();
    this.adapter = new CloudAdapter(this.authConfig);
    this.adapter.onTurnError = async (context, error) => {
      console.error("Teams turn error:", error);
      await context.sendActivity("Sorry, something went wrong. Please try again.").catch(() => {});
    };
    this.roles = new GraphRoleResolver(this.authConfig, opts);
  }

  /** Handle POST /api/messages from Azure Bot Service. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const request = {
      method: req.method,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: await readJson(req, this.opts.maxBodyBytes),
    };
    const response = wrapResponse(res);

    // Verify the request really comes from Azure Bot Service for our bot.
    let authorized = false;
    await authorizeJWT(this.authConfig)(request, response, (err?: unknown) => {
      if (!err) authorized = true;
    });
    if (!authorized) {
      if (!response.writableEnded) response.status(401).send({ error: "Unauthorized" });
      return;
    }

    await this.adapter.process(request, response, (context) => this.onTurn(context));
  }

  private async onTurn(context: TurnContext): Promise<void> {
    const activity = context.activity;

    if (activity.type === "conversationUpdate") {
      const added = activity.membersAdded ?? [];
      if (added.some((m) => m.id === activity.recipient?.id)) await context.sendActivity(WELCOME);
      return;
    }
    if (activity.type !== "message") return;

    const tenant = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
    const aadId = activity.from?.aadObjectId;
    if (tenant !== this.opts.tenantId || !aadId) {
      await context.sendActivity("Sorry, this assistant is only for the O'Dea community.");
      return;
    }

    // In channels and group chats the text includes "<at>ODeaChime</at>".
    const text = (activity.removeRecipientMention() ?? activity.text ?? "").trim();
    const convKey = `teams:${activity.conversation?.id}:${aadId}`;

    if (/^(new chat|reset|start over)$/i.test(text)) {
      this.chat.reset(convKey);
      await context.sendActivity("OK, starting a new conversation. What would you like to know?");
      return;
    }
    const hasImage = (activity.attachments ?? []).some((a) => a.contentType?.startsWith("image/"));
    if (!text) {
      await context.sendActivity(hasImage ? PHOTO_NOTE : WELCOME);
      return;
    }

    const user: ChatUser = { id: `teams:${aadId}`, role: await this.roles.roleFor(aadId) };

    // Teams waits only ~15 s for a reply to its request, and a model answer
    // with tool calls can take longer. So: show "typing…", acknowledge the
    // request now, and post the answer when it's ready (a proactive message).
    await context.sendActivity({ type: "typing" } as never);
    const reference = activity.getConversationReference();
    const botId = this.authConfig.clientId ?? "";

    void this.chat
      .ask({ user, channel: "teams", message: text, conversationId: convKey, conversationKeyIsStable: true })
      .then(
        (result) => (hasImage ? `${result.reply}\n\n_${PHOTO_NOTE}_` : result.reply),
        (err) => (err instanceof ChatError ? err.message : (console.error("Teams ask failed:", err), "Sorry, something went wrong. Please try again.")),
      )
      .then((reply) => this.adapter.continueConversation(botId, reference, (ctx) => ctx.sendActivity(reply).then(() => {})))
      .catch((err) => console.error("Teams reply failed:", err));
  }
}

/**
 * Maps a Teams user to a role from their Entra ID group memberships
 * (Microsoft Graph checkMemberGroups). Needs the bot's app registration to
 * have the GroupMember.Read.All application permission with admin consent.
 * Without groups configured, everyone gets the default role.
 */
class GraphRoleResolver {
  private token: { value: string; expires: number } | null = null;
  private readonly cache = new Map<string, { role: Role; expires: number }>();

  constructor(
    private readonly auth: AuthConfiguration,
    private readonly opts: TeamsOptions,
  ) {}

  async roleFor(aadObjectId: string): Promise<Role> {
    const { staffGroupIds, studentGroupIds, defaultRole } = this.opts;
    if (!staffGroupIds.length && !studentGroupIds.length) return defaultRole;
    const hit = this.cache.get(aadObjectId);
    if (hit && hit.expires > Date.now()) return hit.role;

    let role = defaultRole;
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(aadObjectId)}/checkMemberGroups`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.graphToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ groupIds: [...staffGroupIds, ...studentGroupIds] }),
      });
      if (!res.ok) throw new Error(`Graph answered ${res.status}`);
      const groups = ((await res.json()) as { value: string[] }).value;
      role = groups.some((g) => staffGroupIds.includes(g)) ? "staff" : groups.some((g) => studentGroupIds.includes(g)) ? "student" : defaultRole;
    } catch (err) {
      // Fail closed: lookups that fail get the default (least) role, uncached.
      console.error("Teams role lookup failed:", err);
      return defaultRole;
    }
    this.cache.set(aadObjectId, { role, expires: Date.now() + 6 * 3_600_000 });
    return role;
  }

  private async graphToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.auth.clientId ?? "",
        client_secret: this.auth.clientSecret ?? "",
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    if (!res.ok) throw new Error(`Token request answered ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

async function readJson(req: http.IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error("Teams request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Adapts Node's ServerResponse to the SDK's framework-agnostic WebResponse. */
function wrapResponse(res: http.ServerResponse): WebResponse {
  const w: WebResponse = {
    status(code: number) {
      res.statusCode = code;
      return w;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
      return w;
    },
    send(body?: unknown) {
      if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
        if (!res.headersSent) res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      } else {
        res.end(body);
      }
      return w;
    },
    end() {
      res.end();
      return w;
    },
    get headersSent() {
      return res.headersSent;
    },
    get writableEnded() {
      return res.writableEnded;
    },
  };
  return w;
}
