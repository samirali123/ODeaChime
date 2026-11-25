// Create the database tables (also done automatically when the server starts).
import { createPool, migrate } from "../db.js";

const pool = createPool(process.env.DATABASE_URL);
if (!pool) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}
await migrate(pool);
await pool.end();
console.log("database ready");
