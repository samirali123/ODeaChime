import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringArg, type Tool } from "./registry.js";

// BellForge, read-only.
//
// Two inputs:
//  - schedules.json: the schedule TYPES (Maroon Day, Gold 1-Hour Late Start,
//    ...) exactly as BellForge stores them in schools/odea/schedules.json.
//  - calendar cache: what is actually on the CyberData calendar, pushed by
//    the BellForge desktop app (POST /api/bellforge/sync) in the same shape
//    BellForge's engine.readMonth() returns. The assistant never logs in to
//    the bell device itself. See docs/BELLFORGE.md.

export interface Block {
  title: string;
  start: string;
  end?: string;
  color: string;
  details?: string;
}
export interface ScheduleType {
  label: string;
  blocks: Block[];
}
export interface SchedulesFile {
  order: string[];
  schedules: Record<string, ScheduleType>;
}

export interface CalendarEvent {
  id?: string;
  start: string; // "HH:MM"
  title: string;
  details?: string;
  color?: string;
}
export interface CalendarDay {
  date: string; // "YYYY-MM-DD"
  inMonth?: boolean;
  events: CalendarEvent[];
}
export interface CalendarMonth {
  year: number;
  month: number;
  days: CalendarDay[];
}
export interface CalendarCache {
  syncedAt: string | null;
  days: Record<string, CalendarEvent[]>;
  months: string[]; // "YYYY-MM" that have been synced
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BellForgeStore {
  private cache: CalendarCache = { syncedAt: null, days: {}, months: [] };

  constructor(
    readonly schedules: SchedulesFile,
    private readonly cachePath: string,
  ) {}

  static async open(schedulesPath: string, cachePath: string): Promise<BellForgeStore> {
    const schedules = JSON.parse(await readFile(schedulesPath, "utf8")) as SchedulesFile;
    const store = new BellForgeStore(schedules, cachePath);
    try {
      store.cache = JSON.parse(await readFile(cachePath, "utf8")) as CalendarCache;
    } catch {
      // Nothing synced yet.
    }
    return store;
  }

  get syncedAt(): string | null {
    return this.cache.syncedAt;
  }

  /** Merge months pushed by the BellForge desktop app. Whole months replace what was there. */
  async applySync(months: CalendarMonth[], at = new Date()): Promise<{ months: number; days: number }> {
    let dayCount = 0;
    for (const m of months) {
      if (!Number.isInteger(m.year) || !Number.isInteger(m.month) || !Array.isArray(m.days)) {
        throw new Error("Each month needs year, month and days.");
      }
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      for (const date of Object.keys(this.cache.days)) if (date.startsWith(key)) delete this.cache.days[date];
      for (const d of m.days) {
        if (d.inMonth === false || !DATE_RE.test(d.date) || !d.date.startsWith(key)) continue;
        this.cache.days[d.date] = (d.events ?? [])
          .map((e) => ({ id: e.id, start: e.start, title: e.title, details: e.details, color: e.color }))
          .sort((a, b) => a.start.localeCompare(b.start));
        dayCount++;
      }
      if (!this.cache.months.includes(key)) this.cache.months.push(key);
    }
    this.cache.months.sort();
    this.cache.syncedAt = at.toISOString();
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache));
    await rename(tmp, this.cachePath);
    return { months: months.length, days: dayCount };
  }

  /** null = that month was never synced, so we don't know. [] = synced, no bells. */
  bellsOn(date: string): CalendarEvent[] | null {
    if (this.cache.days[date]) return this.cache.days[date];
    return this.cache.months.includes(date.slice(0, 7)) ? [] : null;
  }

  findType(nameOrKey: string): [string, ScheduleType] | null {
    const q = normalize(nameOrKey);
    for (const [key, s] of Object.entries(this.schedules.schedules)) {
      if (normalize(key) === q || normalize(s.label) === q) return [key, s];
    }
    const partial = Object.entries(this.schedules.schedules).filter(
      ([key, s]) => normalize(s.label).includes(q) || normalize(key).includes(q),
    );
    return partial.length === 1 ? partial[0] : null;
  }

  /**
   * Which schedule type a day's bells match. BellForge creates one bell at
   * each block start, plus a Pass/Dismissal bell at each block end, so we
   * compare those trigger times.
   */
  inferType(events: CalendarEvent[]): { key: string; label: string; match: number } | null {
    if (!events.length) return null;
    const actual = new Set(events.map((e) => e.start));
    let best: { key: string; label: string; match: number } | null = null;
    for (const [key, s] of Object.entries(this.schedules.schedules)) {
      const expected = triggerTimes(s);
      const inter = [...expected].filter((t) => actual.has(t)).length;
      const union = new Set([...expected, ...actual]).size;
      const match = union ? inter / union : 0;
      if (!best || match > best.match) best = { key, label: s.label, match };
    }
    return best && best.match >= 0.8 ? best : null;
  }
}

export function triggerTimes(s: ScheduleType): Set<string> {
  const times = new Set<string>();
  for (const b of s.blocks) {
    times.add(b.start);
    if (b.end) times.add(b.end);
  }
  return times;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function describeType(key: string, s: ScheduleType): string {
  const lines = s.blocks.map(
    (b) =>
      `- ${b.details || b.title} (${b.title}): ${to12h(b.start)}${b.end ? `–${to12h(b.end)}` : " (announcement)"}`,
  );
  return `${s.label} [${key}]\n${lines.join("\n")}`;
}

/** Today's date in the school's time zone, as YYYY-MM-DD. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function bellforgeTools(store: BellForgeStore, timeZone: string): Tool[] {
  return [
    {
      name: "bell_schedule_types",
      description:
        "List every O'Dea bell schedule type (Maroon Day, Gold Day, late starts, finals, ...). Use this when the user asks what schedules exist or names one you need to look up.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      minRole: "public",
      async run() {
        return store.schedules.order
          .map((k) => `${store.schedules.schedules[k]?.label} [${k}]`)
          .join("\n");
      },
    },
    {
      name: "bell_schedule",
      description:
        "Get the periods and times of one bell schedule type, e.g. 'Gold 2-Hour Late Start'. These are the official BellForge definitions. Does not say which day uses it; use bell_day for that.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Schedule label or key, e.g. 'Maroon Day' or 'goldLate1hr'" } },
        required: ["name"],
        additionalProperties: false,
      },
      minRole: "public",
      async run(input) {
        const name = stringArg(input, "name")!;
        const found = store.findType(name);
        if (!found) return `No single schedule type matches "${name}". Call bell_schedule_types for the list.`;
        return `Source: BellForge schedule definitions\n${describeType(found[0], found[1])}`;
      },
    },
    {
      name: "bell_day",
      description:
        "What is actually scheduled on the bell system for a date: which schedule type it is (Maroon, Gold, late start, ...) and every bell time. Use for questions like 'what schedule is Friday?' or 'when is lunch today?'. Date defaults to today.",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD; omit for today" } },
        additionalProperties: false,
      },
      minRole: "public",
      async run(input, ctx) {
        const date = stringArg(input, "date", false) ?? localDate(ctx.now, timeZone);
        if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD.");
        const bells = store.bellsOn(date);
        const synced = store.syncedAt ? `last synced ${store.syncedAt}` : "never synced";
        if (bells === null) {
          return `The bell calendar for ${date.slice(0, 7)} hasn't been synced from BellForge (${synced}), so the schedule for ${date} is unknown. Tell the user to check the school calendar.`;
        }
        if (!bells.length) return `Source: BellForge bell calendar (${synced})\nNo bells are scheduled on ${date} (likely no school or a weekend).`;
        const type = store.inferType(bells);
        const header = type
          ? `${date} is a ${type.label} [${type.key}]${type.match < 1 ? " (with some changes from the standard version)" : ""}.`
          : `${date} has bells that don't match a standard schedule type.`;
        const list = bells.map((b) => `- ${to12h(b.start)} ${b.title}${b.details && b.details !== b.title ? ` (${b.details})` : ""}`);
        return `Source: BellForge bell calendar (${synced})\n${header}\nBells:\n${list.join("\n")}`;
      },
    },
  ];
}
