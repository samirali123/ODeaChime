# BellForge integration

The assistant answers bell questions ("What schedule is Friday?", "When is
lunch on a 2-hour late start?") from two BellForge sources:

| Source | What it holds | How the assistant gets it |
|---|---|---|
| `schools/odea/schedules.json` | The schedule **types** (Maroon Day, Gold 1-Hour Late Start, Finals…) and their periods | Read from disk (`BELLFORGE_SCHEDULES_PATH`, or the bundled snapshot in `orchestrator/src/data/`) |
| The CyberData/InformaCast calendar | Which bells are **actually scheduled** on each date | **Pushed** by the BellForge desktop app to `POST /api/bellforge/sync` |

Tools: `bell_schedule_types`, `bell_schedule`, `bell_day` (`orchestrator/src/tools/bellforge.ts`).
`bell_day` works out which schedule type a date is by matching its bell
times against each type's start and end (pass/dismissal) times.

## Decision 3: why BellForge pushes the calendar, not the server logging in

Reading the calendar needs a logged-in session on the CyberData device.
Two ways to get the data to the assistant:

**A. The BellForge desktop app pushes it (chosen).** BellForge already reads
the calendar month by month while someone is logged in. After each read
(and after each job finishes), it also sends those months to the assistant
server with a shared token.
- The server never holds a password or a session for the bell device, so a
  break-in on the assistant server can't change or delete bells.
- No new device account to create, rotate or audit.
- Nothing extra ever talks to the device, which handles only one request
  at a time (~15 s per bell written). The chatbot can't slow BellForge down.
- Downside: the data is only as fresh as the last time someone opened
  BellForge. Bells are planned ahead, so a monthly or weekly sync is enough
  in practice, and `bell_day` tells users when a month was never synced.

**B. The server logs in itself.** A dedicated CyberData account whose
credentials live on the assistant server, and a background job that reads
the calendar every 30 minutes.
- Always fresh, needs no one to open BellForge.
- But it puts a working bell-system login on a server that's reachable from
  Teams and the web, and it adds load to a device that queues every request.
  The BellForge engine also gets its session from the device's login page in
  a browser window today, so a headless login would need new, untested code.

**Recommendation:** start with A. Move to B only if stale data becomes a real
problem, and then with a read-only device account if CyberData supports one.

## The sync contract (for BellForge)

```
POST /api/bellforge/sync
Authorization: Bearer <BELLFORGE_SYNC_TOKEN>
Content-Type: application/json

{ "months": [ <engine.readMonth(year, month) result>, ... ] }
```

Each month is exactly what `engine/platforms/cyberdata.js` `readMonth()`
returns: `{ year, month, days: [{ date, inMonth, events: [{ id, start, title, details, color }] }] }`.
A pushed month replaces everything stored for that month. Cells outside the
month (`inMonth: false`) are ignored. Response: `{ ok, months, days, syncedAt }`.

### Changes needed in BellForge2.0 (not made yet)

1. Settings: assistant server URL and sync token, stored in `settings.json`
   (the token in the OS keychain if possible).
2. In `main.js`, after a successful `readMonth` and after each job's
   verification re-read, post that month in the background. Failures only
   log; they never block BellForge.
3. A "Sync next 3 months to the assistant" menu item for a full refresh.

Phase 6 (later): staff ask the assistant to apply a schedule. The
assistant creates a **proposed job** that BellForge shows for a person to
confirm, so writes still go through BellForge's job queue, re-read checks
and activity log, with the signed-in Microsoft 365 identity as "who".
