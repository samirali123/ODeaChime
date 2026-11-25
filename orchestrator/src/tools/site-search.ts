import type pg from "pg";
import { stringArg, type Tool } from "./registry.js";

// Search the indexed O'Dea website (and uploaded documents).
// Phase 1 uses Postgres full-text search: no embedding model needed.
// Phase 3 can add pgvector embeddings alongside it (hybrid search).

export interface SearchHit {
  url: string;
  title: string;
  heading: string | null;
  content: string;
  rank: number;
}

export async function searchChunks(pool: pg.Pool, query: string, limit = 5, audience = "public"): Promise<SearchHit[]> {
  const { rows } = await pool.query<SearchHit>(
    `SELECT url, title, heading, content, ts_rank(tsv, q) AS rank
       FROM chunks, websearch_to_tsquery('english', $1) q
      WHERE tsv @@ q AND audience = ANY($3)
      ORDER BY rank DESC
      LIMIT $2`,
    [query, limit, audiencesFor(audience)],
  );
  return rows;
}

function audiencesFor(role: string): string[] {
  // Staff see staff-only documents too; everyone sees public ones.
  return role === "staff" || role === "admin" ? ["public", "student", "staff"] : role === "student" ? ["public", "student"] : ["public"];
}

export function siteSearchTool(pool: pg.Pool | undefined): Tool {
  return {
    name: "search_odea_site",
    description:
      "Search O'Dea High School's website and approved school documents (handbook, policies, admissions, athletics, events, contacts). Returns text passages with their source URLs. Use short keyword queries; search again with different words if the first results don't answer the question.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords, e.g. 'dress code' or 'admissions open house'" } },
      required: ["query"],
      additionalProperties: false,
    },
    minRole: "public",
    async run(input, ctx) {
      if (!pool) return "Website search isn't set up on this server yet (no DATABASE_URL).";
      const query = stringArg(input, "query")!;
      const hits = await searchChunks(pool, query, 5, ctx.role);
      if (!hits.length) return `No results for "${query}".`;
      return hits
        .map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` › ${h.heading}` : ""}\nURL: ${h.url}\n${h.content}`)
        .join("\n\n---\n\n");
    },
  };
}
