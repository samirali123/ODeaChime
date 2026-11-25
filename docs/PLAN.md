# ODeaChime: plan

An on-site AI assistant for O'Dea High School, running on the school's own
server with **Claude Haiku 5.5** as the model. Staff (and later students and
families) ask questions on a web page or in **Microsoft Teams** and get
answers from approved sources: the school website and documents, BellForge's
bell schedules, and calendars. It can also read photos (flyers, posted
schedules). Later, staff can ask it to do things, starting with bell
schedules through BellForge, always with a person confirming.

## Architecture

```
 Staff browser ──HTTPS──► Caddy ──► oauth2-proxy (Microsoft 365 sign-in) ──┐
 Teams ──► Azure Bot Service ──► Cloudflare Tunnel (/api/messages only) ───┤
 BellForge desktop app ──(sync token)──► Caddy ─────────────────────────────┤
                                                                            ▼
 ┌─────────────────────────── orchestrator (TypeScript) ──────────────────────────┐
 │ channels: web, Teams ─► ChatService: roles · rate limits · logging           │
 │                           │                                                  │
 │                ModelRouter: Claude Haiku 5.5 (on-site model optional)        │
 │                           │                                                  │
 │                tool loop ─► tools: search_odea_site · bell_day · bell_schedule │
 └───────────────┬───────────────────────┬────────────────────────────┬─────────┘
                 ▼                       ▼                            ▼
          Postgres (+pgvector)    Claude API (Haiku 5.5)       BellForge cache
          pages · chunks · logs                                 (pushed by BellForge)
```

- **One service, many channels.** Web and Teams both call
  `ChatService.ask()`, so roles, limits, tools and logs are identical.
- **Every data source is a set of tools** with a minimum role. New sources
  (lunch menu, athletics, LMS) are new tool files. These can become MCP
  servers later if other apps need them.
- **Model independence.** Providers implement one interface
  (`models/types.ts`); the router picks per conversation.

## Phases

| Phase | Delivers | Done when |
|---|---|---|
| 0. Groundwork | Admin/IT sign-off, data sources, eval set filled in, server, Entra ID app registration | Decisions 3, 6, 7 settled |
| 1. Staff pilot on the web | Web chat behind Microsoft 365 sign-in, website search with sources, bell tools | ≥ 90% on the eval set; 10–20 staff testers |
| 2. Teams | Bot in Teams for staff | Same eval results via Teams |
| 3. BellForge sync | BellForge pushes calendar months | `bell_day` right for every synced day |
| 4. Tuning | Prompt and tool improvements from pilot logs; Sonnet 5.5 for questions Haiku gets wrong, if needed | ≥ 95% on the eval set |
| 5. More sources | PDFs and uploaded documents, calendar (ICS), embeddings (hybrid search), photos in Teams | Eval questions per source |
| 6. Staff actions | "Apply Gold late start to Tuesday" → proposed BellForge job, confirmed by a person, logged with the M365 identity | Admin sign-off |
| Optional | On-site model on a GPU (code is ready: `PRIMARY_MODEL=ollama`); a Copilot agent that uses our tools (decision 8) | When budget and need appear |
| 7. Wider rollout | Students, then families: roles, moderation, retention | Pilot with one grade first |

## Safety

- Answers come from tools, with sources; "I don't know" beats a guess.
- No grades, attendance or student records.
- Tool output and photo text are treated as data, never instructions.
- Rate limits per user; conversations logged for review (retention per decision 6).
- The bell device's credentials never live on this server (decision 3).
- Write actions (phase 6) always need a person to confirm in BellForge.

See [DECISIONS.md](DECISIONS.md), [BELLFORGE.md](BELLFORGE.md), [TEAMS.md](TEAMS.md).
