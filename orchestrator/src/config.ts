import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Effort } from "./models/claude.js";
import type { Role } from "./tools/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const ROLES: Role[] = ["public", "student", "staff", "admin"];
function role(v: string | undefined, fallback: Role): Role {
  return ROLES.includes(v as Role) ? (v as Role) : fallback;
}

export const config = {
  port: Number(env("PORT", "8080")),
  webDir: env("WEB_DIR", path.resolve(here, "../../web"))!,
  dataDir: env("DATA_DIR", path.resolve(here, "../../data"))!,
  timeZone: env("SCHOOL_TIME_ZONE", "America/Los_Angeles")!,

  // Claude (primary). Haiku 5.5 is the low-cost default; set CLAUDE_MODEL=claude-sonnet-5-5 for harder work.
  claude: env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")
    ? {
        model: env("CLAUDE_MODEL", "claude-haiku-5-5")!,
        effort: (env("CLAUDE_EFFORT", "low") as Effort),
      }
    : undefined,

  // Local model through Ollama (optional).
  ollama: env("OLLAMA_URL")
    ? {
        baseUrl: env("OLLAMA_URL")!,
        model: env("OLLAMA_MODEL", "qwen3-vl:8b")!,
        supportsVision: env("OLLAMA_VISION", "true") === "true",
      }
    : undefined,
  /**
   * Which model answers by default. O'Dea runs on Claude Haiku 5.5; "ollama"
   * is kept for a possible on-site GPU model later.
   */
  primaryModel: env("PRIMARY_MODEL", "claude") as "claude" | "ollama",
  /** Only with PRIMARY_MODEL=ollama: when the on-site model is down, may Claude answer instead? */
  allowClaudeFallback: env("ALLOW_CLAUDE_FALLBACK", "true") === "true",
  /** Lowest role allowed to use the assistant at all. "staff" for the staff-only launch. */
  minRole: role(env("ASSISTANT_MIN_ROLE"), "staff"),

  databaseUrl: env("DATABASE_URL"),

  bellforge: {
    schedulesPath: env("BELLFORGE_SCHEDULES_PATH", path.resolve(here, "data/odea-schedules.json"))!,
    /** Shared secret the BellForge desktop app sends when pushing calendar data. */
    syncToken: env("BELLFORGE_SYNC_TOKEN"),
  },

  auth: {
    /**
     * When true, trust X-Forwarded-User / X-Forwarded-Groups from the reverse
     * proxy (oauth2-proxy in front of Google or Microsoft sign-in). Only turn
     * this on when the orchestrator is reachable solely through that proxy.
     */
    trustProxyHeaders: env("TRUST_PROXY_AUTH", "false") === "true",
    defaultRole: role(env("DEFAULT_ROLE"), "public"),
    staffGroups: (env("STAFF_GROUPS", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    studentGroups: (env("STUDENT_GROUPS", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    adminUsers: (env("ADMIN_USERS", "") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  /**
   * Microsoft Teams (optional). The Agents SDK reads the bot's own
   * credentials from `clientId`, `clientSecret` and `tenantId` env vars.
   * See docs/TEAMS.md.
   */
  teams:
    env("TEAMS_ENABLED", "false") === "true"
      ? {
          tenantId: env("tenantId") ?? "",
          defaultRole: role(env("TEAMS_DEFAULT_ROLE"), "student"),
          staffGroupIds: list(env("TEAMS_STAFF_GROUP_IDS")),
          studentGroupIds: list(env("TEAMS_STUDENT_GROUP_IDS")),
        }
      : undefined,

  limits: {
    messagesPerHour: Number(env("RATE_LIMIT_PER_HOUR", "60")),
    maxBodyBytes: Number(env("MAX_BODY_BYTES", String(8 * 1024 * 1024))),
    maxMessageChars: 4000,
    conversationTtlMinutes: 60,
  },
};

export type Config = typeof config;
