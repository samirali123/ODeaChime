// Crawl the O'Dea website into the search index.
//
//   npm run crawl                       # uses ODEA_SITE_URL, default https://www.odea.org/
//   CRAWL_MAX_PAGES=50 npm run crawl
//
// Polite by design: same host only, honors robots.txt (User-agent: *),
// one request at a time with a delay, and skips pages whose text hasn't changed.

import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type pg from "pg";
import { createPool, migrate } from "../db.js";

const START = process.env.ODEA_SITE_URL ?? "https://www.odea.org/";
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 500);
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 750);
const USER_AGENT = "ODeaChimeCrawler/0.1 (on-site school assistant)";
const CHUNK_CHARS = 1500;

export interface Page {
  url: string;
  title: string;
  sections: { heading: string | null; text: string }[];
  links: string[];
}

export function extractPage(html: string, url: string): Page {
  const $ = cheerio.load(html);
  const links = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get()
    .map((href) => {
      try {
        const u = new URL(href, url);
        u.hash = "";
        return u.toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => !!u);

  $("script, style, noscript, svg, iframe, nav, header, footer, form, [aria-hidden=true]").remove();
  const title = ($("title").first().text() || $("h1").first().text() || url).replace(/\s+/g, " ").trim();
  const root = $("main").length ? $("main").first() : $("body");

  // Walk headings and text blocks in order, grouping text under its nearest heading.
  const sections: Page["sections"] = [];
  let current: Page["sections"][number] = { heading: null, text: "" };
  root.find("h1, h2, h3, h4, p, li, td, th, dt, dd, blockquote, pre").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    // Skip containers whose text a nested block element will also contribute.
    if ((tag === "li" || tag === "td") && $(el).find("p, li").length) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (/^h[1-4]$/.test(tag)) {
      if (current.text) sections.push(current);
      current = { heading: text, text: "" };
    } else {
      current.text += (current.text ? "\n" : "") + text;
    }
  });
  if (current.text) sections.push(current);
  return { url, title, sections, links };
}

export function chunkSections(sections: Page["sections"], max = CHUNK_CHARS): { heading: string | null; content: string }[] {
  const out: { heading: string | null; content: string }[] = [];
  for (const s of sections) {
    let buf = "";
    for (const para of s.text.split("\n")) {
      if (buf && buf.length + para.length + 1 > max) {
        out.push({ heading: s.heading, content: buf });
        buf = "";
      }
      buf += (buf ? "\n" : "") + para.slice(0, max * 2);
    }
    if (buf) out.push({ heading: s.heading, content: buf });
  }
  return out;
}

async function robotsDisallows(origin: string): Promise<string[]> {
  try {
    const res = await fetch(new URL("/robots.txt", origin), { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return [];
    const lines = (await res.text()).split(/\r?\n/);
    const rules: string[] = [];
    let applies = false;
    for (const line of lines) {
      const [k, ...rest] = line.split(":");
      const key = k.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") applies = value === "*";
      else if (applies && key === "disallow" && value) rules.push(value);
    }
    return rules;
  } catch {
    return [];
  }
}

function shouldVisit(u: URL, host: string, disallow: string[]): boolean {
  if (u.host !== host || !/^https?:$/.test(u.protocol)) return false;
  if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3|ics)$/i.test(u.pathname)) return false; // PDFs: Phase 3
  return !disallow.some((rule) => u.pathname.startsWith(rule));
}

async function savePage(pool: pg.Pool, page: Page): Promise<"new" | "changed" | "same" | "empty"> {
  const chunks = chunkSections(page.sections);
  if (!chunks.length) return "empty";
  const hash = createHash("sha256").update(JSON.stringify(chunks)).digest("hex");
  const prev = await pool.query<{ content_hash: string }>("SELECT content_hash FROM documents WHERE url = $1", [page.url]);
  if (prev.rows[0]?.content_hash === hash) {
    await pool.query("UPDATE documents SET fetched_at = now() WHERE url = $1", [page.url]);
    return "same";
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO documents (url, title, source, audience, content_hash) VALUES ($1, $2, 'website', 'public', $3)
       ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, content_hash = EXCLUDED.content_hash, fetched_at = now()`,
      [page.url, page.title, hash],
    );
    await client.query("DELETE FROM chunks WHERE url = $1", [page.url]);
    for (const c of chunks) {
      await client.query("INSERT INTO chunks (url, title, heading, content, audience) VALUES ($1, $2, $3, $4, 'public')", [
        page.url,
        page.title,
        c.heading,
        c.content,
      ]);
    }
    await client.query("COMMIT");
    return prev.rows.length ? "changed" : "new";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function crawl(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL);
  if (!pool) throw new Error("Set DATABASE_URL.");
  await migrate(pool);

  const start = new URL(START);
  const disallow = await robotsDisallows(start.origin);
  const queue = [start.toString()];
  const seen = new Set(queue);
  const counts = { new: 0, changed: 0, same: 0, empty: 0, failed: 0 };

  while (queue.length && seen.size - queue.length < MAX_PAGES) {
    const url = queue.shift()!;
    try {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("text/html")) {
        if (!res.ok) counts.failed++;
        continue;
      }
      const page = extractPage(await res.text(), res.url);
      counts[await savePage(pool, page)]++;
      for (const link of page.links) {
        const u = new URL(link);
        u.search = ""; // query-string variants are almost always duplicates
        const clean = u.toString();
        if (!seen.has(clean) && shouldVisit(u, start.host, disallow)) {
          seen.add(clean);
          queue.push(clean);
        }
      }
    } catch (err) {
      counts.failed++;
      console.warn(`skip ${url}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log("crawl done", counts);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  crawl().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
