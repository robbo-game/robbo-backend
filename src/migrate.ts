import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');
const pool = new Pool({ connectionString: url });
try { await pool.query(await readFile(join(fileURLToPath(new URL('..', import.meta.url)), '../sql/001_initial.sql'), 'utf8')); } finally { await pool.end(); }
