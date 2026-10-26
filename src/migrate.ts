import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');
const pool = new Pool({ connectionString: url });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(730924)");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migration(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of ['001_initial.sql', '002_auth_leaderboards.sql', '003_checkpoints.sql']) {
      const exists = await client.query('SELECT name FROM schema_migration WHERE name=$1', [file]);
      if (!exists.rowCount) { await client.query(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8')); await client.query('INSERT INTO schema_migration(name) VALUES($1)', [file]); }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
} finally { await pool.end(); }
