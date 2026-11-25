-- O'Dea Assistant database. Idempotent: safe to run on every start.

CREATE EXTENSION IF NOT EXISTS vector; -- for Phase 3 embeddings; unused in Phase 1

-- One row per crawled page or uploaded document.
CREATE TABLE IF NOT EXISTS documents (
  url          TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'website',   -- website | upload | calendar
  audience     TEXT NOT NULL DEFAULT 'public',    -- public | student | staff
  content_hash TEXT NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Passages that search returns.
CREATE TABLE IF NOT EXISTS chunks (
  id        BIGSERIAL PRIMARY KEY,
  url       TEXT NOT NULL REFERENCES documents(url) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  heading   TEXT,
  content   TEXT NOT NULL,
  audience  TEXT NOT NULL DEFAULT 'public',
  tsv       TSVECTOR GENERATED ALWAYS AS (
              setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
              setweight(to_tsvector('english', content), 'C')
            ) STORED,
  embedding vector(768)
);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_url_idx ON chunks (url);

-- Who asked what, for review and abuse handling. Keep per the agreed retention.
CREATE TABLE IF NOT EXISTS chat_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  model           TEXT NOT NULL,
  question        TEXT NOT NULL,
  had_image       BOOLEAN NOT NULL DEFAULT false,
  answer          TEXT NOT NULL,
  tools_used      TEXT[] NOT NULL DEFAULT '{}',
  stop            TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  flagged         BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web'; -- web | teams
CREATE INDEX IF NOT EXISTS chat_log_at_idx ON chat_log (at);
