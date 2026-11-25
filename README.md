# ODeaChime

An on-site AI assistant for O'Dea High School. Staff ask questions on a web
page or in **Microsoft Teams** and get answers from the school website, the
**BellForge** bell schedules and (later) calendars and documents, with sources.
It runs on the school's own server, with Claude Haiku 5.5 as the model. An
on-site model on a GPU remains an option for later.

- **Plan:** [docs/PLAN.md](docs/PLAN.md)
- **Decisions and GPU sizing:** [docs/DECISIONS.md](docs/DECISIONS.md)
- **BellForge integration:** [docs/BELLFORGE.md](docs/BELLFORGE.md)
- **Teams setup:** [docs/TEAMS.md](docs/TEAMS.md)

## Layout

```
orchestrator/        TypeScript service: chat API, Teams bot, model router, tools
  src/chat/          ChatService (shared by every channel), tool loop, system prompt
  src/channels/      teams.ts (Microsoft 365 Agents SDK)
  src/models/        claude.ts, ollama.ts, router.ts
  src/tools/         bellforge.ts, site-search.ts
  src/ingest/        crawl.ts (odea.org → Postgres full-text index)
  db/schema.sql
  test/              node --test
web/                 the chat page (no build step)
teams/               Teams app manifest, icons, build-package.py
deploy/Caddyfile     HTTPS + routing
evals/               questions with expected answers
docker-compose.yml   caddy, oauth2-proxy, orchestrator, postgres, ollama*, cloudflared*
```

## Run it locally (development)

```bash
cd orchestrator && npm install
```

```bash
ANTHROPIC_API_KEY=... PRIMARY_MODEL=claude ASSISTANT_MIN_ROLE=public npm run dev
```

Open http://localhost:8080. Without `DATABASE_URL`, website search is off;
the bell tools work. To index the website, start Postgres and run
`DATABASE_URL=postgres://... npm run crawl`.

```bash
npm test
```

## Run it on the school server

```bash
cp .env.example .env
```

Fill in `.env` (see the comments), then:

```bash
docker compose up -d
```

```bash
docker compose run --rm orchestrator node dist/ingest/crawl.js
```

Add `--profile local` for the on-site model (GPU) and `--profile teams` for
the Teams tunnel.

## Status

Phase 1 code: web chat, Teams channel, Claude Haiku 5.5 (on-site model
optional), BellForge read tools with a sync endpoint, website crawler and
search, staff-only gate, 21 unit tests. Not yet tried against a live model
or the live website; see the plan for what's next.
