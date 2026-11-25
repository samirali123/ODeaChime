import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BellForgeStore, bellforgeTools, localDate, triggerTimes } from "../src/tools/bellforge.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULES = path.resolve(here, "../src/data/odea-schedules.json");
const ctx = { role: "public" as const, userId: "t", now: new Date("2026-12-01T17:00:00Z") };

async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bf-"));
  return BellForgeStore.open(SCHEDULES, path.join(dir, "cal.json"));
}

/** Bells as BellForge would create them for a schedule type (start + pass/dismissal). */
function bellsFor(s: BellForgeStore, key: string) {
  return [...triggerTimes(s.schedules.schedules[key])].map((start) => ({ start, title: "x" }));
}

test("finds schedule types by label or key", async () => {
  const s = await store();
  assert.equal(s.findType("Maroon Day")?.[0], "maroon");
  assert.equal(s.findType("goldLate2hr")?.[0], "goldLate2hr");
  assert.equal(s.findType("gold")?.[0], "gold"); // exact key wins over the many partial matches
  assert.equal(s.findType("late start"), null); // ambiguous: several match
});

test("bell_schedule describes a schedule in 12-hour time", async () => {
  const s = await store();
  const tool = bellforgeTools(s, "America/Los_Angeles").find((t) => t.name === "bell_schedule")!;
  const out = await tool.run({ name: "Maroon Day" }, ctx);
  assert.match(out, /Lunch \(Lunch\): 11:15 AM–11:35 AM/);
});

test("unsynced months are unknown, synced empty days have no bells", async () => {
  const s = await store();
  assert.equal(s.bellsOn("2026-12-01"), null);
  await s.applySync([{ year: 2026, month: 12, days: [{ date: "2026-12-02", inMonth: true, events: bellsFor(s, "gold") }] }]);
  assert.deepEqual(s.bellsOn("2026-12-01"), []);
  assert.ok(s.bellsOn("2026-12-02")!.length > 0);
});

test("infers the schedule type of a synced day", async () => {
  const s = await store();
  await s.applySync([
    {
      year: 2026,
      month: 12,
      days: [
        { date: "2026-12-01", inMonth: true, events: bellsFor(s, "maroonLate1hr") },
        { date: "2026-11-30", inMonth: false, events: bellsFor(s, "gold") }, // other-month cell: ignored
      ],
    },
  ]);
  const tool = bellforgeTools(s, "America/Los_Angeles").find((t) => t.name === "bell_day")!;
  const out = await tool.run({}, ctx); // defaults to "today" = 2026-12-01 in Seattle
  assert.match(out, /Maroon 1-Hour Late Start/);
  assert.equal(s.bellsOn("2026-11-30"), null);
});

test("localDate uses the school's time zone", () => {
  // 2026-12-02 03:00 UTC is still Dec 1 in Seattle.
  assert.equal(localDate(new Date("2026-12-02T03:00:00Z"), "America/Los_Angeles"), "2026-12-01");
});

test("sync persists across restarts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bf-"));
  const file = path.join(dir, "cal.json");
  const a = await BellForgeStore.open(SCHEDULES, file);
  await a.applySync([{ year: 2027, month: 1, days: [{ date: "2027-01-05", events: [{ start: "07:10", title: "M0" }] }] }]);
  const b = await BellForgeStore.open(SCHEDULES, file);
  assert.equal(b.bellsOn("2027-01-05")?.[0].title, "M0");
  assert.ok(b.syncedAt);
});
