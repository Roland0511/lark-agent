import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
  if (!applied.has("001_initial.sql")) {
    const existing = await client.query<{ name: string | null }>("SELECT to_regclass('public.tasks')::text AS name");
    if (existing.rows[0]?.name) {
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", ["001_initial.sql"]);
      applied.add("001_initial.sql");
    }
  }
  const files = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const migrationSql = await readFile(`${migrationsDir}/${name}`, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(migrationSql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  process.stdout.write("database migration complete\n");
} finally {
  await client.end();
}
