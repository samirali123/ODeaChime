import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { TeamsChannel } from "./channels/teams.js";
import { ChatError, ChatService, type ChatUser } from "./chat/service.js";
import { config } from "./config.js";
import { createPool, migrate } from "./db.js";
import { ClaudeProvider } from "./models/claude.js";
import { OllamaProvider } from "./models/ollama.js";
import { ModelRouter } from "./models/router.js";
import { ModelUnavailableError, type ImageMediaType } from "./models/types.js";
import { BellForgeStore, bellforgeTools, type CalendarMonth } from "./tools/bellforge.js";
import { ToolRegistry, type Role } from "./tools/registry.js";
import { siteSearchTool } from "./tools/site-search.js";

// ---- wiring -----------------------------------------------------------------

const pool = createPool(config.databaseUrl);
if (pool) await migrate(pool);

const bellforge = await BellForgeStore.open(
  config.bellforge.schedulesPath,
  path.join(config.dataDir, "bellforge-calendar.json"),
);

const registry = new ToolRegistry().register(siteSearchTool(pool), ...bellforgeTools(bellforge, config.timeZone));

const claude = config.claude ? new ClaudeProvider(config.claude) : undefined;
const ollama = config.ollama ? new OllamaProvider(config.ollama) : undefined;
const router =
  config.primaryModel === "ollama" && ollama
    ? new ModelRouter({ primary: ollama, fallback: config.allowClaudeFallback ? claude : undefined, local: ollama })
    : new ModelRouter({ primary: claude, fallback: ollama, local: ollama });

const chat = new ChatService({
  router,
  registry,
  pool,
  timeZone: config.timeZone,
  messagesPerHour: config.limits.messagesPerHour,
  maxMessageChars: config.limits.maxMessageChars,
  conversationTtlMinutes: config.limits.conversationTtlMinutes,
  minRole: config.minRole,
});

const teams = config.teams ? new TeamsChannel(chat, { ...config.teams, maxBodyBytes: config.limits.maxBodyBytes }) : undefined;

// ---- web users ------------------------------------------------------------------

function userFor(req: http.IncomingMessage): ChatUser {
  const a = config.auth;
  if (a.trustProxyHeaders) {
    const email = String(req.headers["x-forwarded-email"] ?? req.headers["x-forwarded-user"] ?? "").toLowerCase();
    if (email) {
      const groups = String(req.headers["x-forwarded-groups"] ?? "").split(",").map((g) => g.trim());
      const role: Role = a.adminUsers.includes(email)
        ? "admin"
        : groups.some((g) => a.staffGroups.includes(g))
          ? "staff"
          : groups.some((g) => a.studentGroups.includes(g))
            ? "student"
            : a.defaultRole;
      return { id: email, role };
    }
  }
  return { id: `anon:${req.socket.remoteAddress ?? "unknown"}`, role: a.defaultRole };
}

// ---- HTTP helpers -------------------------------------------------------------

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > config.limits.maxBodyBytes) throw new ChatError(413, "That's too large. Photos must be under about 5 MB.");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ChatError(400, "Request body must be a JSON object.");
  }
}

const IMAGE_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// ---- routes -------------------------------------------------------------------

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const image = body.image as { mediaType?: string; data?: string } | undefined;
  if (image && (!IMAGE_TYPES.includes(image.mediaType as ImageMediaType) || typeof image.data !== "string")) {
    throw new ChatError(400, "Photos must be JPEG, PNG, GIF or WebP.");
  }
  const result = await chat.ask({
    user: userFor(req),
    channel: "web",
    message: typeof body.message === "string" ? body.message : "",
    image: image ? { mediaType: image.mediaType as ImageMediaType, data: image.data! } : undefined,
    conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
    localOnly: body.localOnly === true,
  });
  send(res, 200, result);
}

async function handleBellForgeSync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = config.bellforge.syncToken;
  const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    throw new ChatError(401, "Bad or missing sync token.");
  }
  const body = await readJson(req);
  if (!Array.isArray(body.months)) throw new ChatError(400, "Expected { months: [...] }.");
  try {
    const result = await bellforge.applySync(body.months as CalendarMonth[]);
    send(res, 200, { ok: true, ...result, syncedAt: bellforge.syncedAt });
  } catch (err) {
    throw new ChatError(400, err instanceof Error ? err.message : "Bad sync payload.");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(urlPath: string, res: http.ServerResponse): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.resolve(config.webDir, rel);
  if (!file.startsWith(path.resolve(config.webDir) + path.sep)) throw new ChatError(404, "Not found");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ChatError(404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/api/messages" && teams) return await teams.handle(req, res);
    if (req.method === "POST" && url.pathname === "/api/bellforge/sync") return await handleBellForgeSync(req, res);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, {
        ok: true,
        models: router.describe(),
        search: !!pool,
        teams: !!teams,
        bellforgeSyncedAt: bellforge.syncedAt,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/me") return send(res, 200, userFor(req));
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, res);
    throw new ChatError(404, "Not found");
  } catch (err) {
    if (res.headersSent) {
      console.error(err);
      return void res.end();
    }
    if (err instanceof ChatError) return send(res, err.status, { error: err.message });
    if (err instanceof Anthropic.RateLimitError) return send(res, 503, { error: "The assistant is busy. Try again in a minute." });
    if (err instanceof ModelUnavailableError) {
      console.error("Model unreachable:", err.cause ?? err.message);
      return send(res, 503, { error: "Can't reach the AI service right now." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error ${err.status}:`, err.message);
      return send(res, 502, { error: "The AI service had a problem. Try again." });
    }
    console.error(err);
    return send(res, 500, { error: "Something went wrong." });
  }
});

server.listen(config.port, () => {
  console.log(`O'Dea Assistant on :${config.port}`, {
    ...router.describe(),
    search: !!pool,
    teams: !!teams,
  });
});
