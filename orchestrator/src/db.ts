import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string | undefined): pg.Pool | undefined {
  return databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
}

/** Create tables if missing. Safe on every start. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = await readFile(path.resolve(here, "../db/schema.sql"), "utf8");
  await pool.query(sql);
}
