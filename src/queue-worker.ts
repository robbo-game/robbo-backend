import { Pool } from 'pg';
import { runVerificationJob } from './leaderboard.js';
import { verifyInWorker } from './verifier.js';
import { setTimeout } from 'node:timers/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL must be set');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
try {
  while (!stopped) {
    try { if (!await runVerificationJob(pool, verifyInWorker)) await setTimeout(1000); }
    catch { console.error('Verification job storage unavailable; retrying'); await setTimeout(5000); }
    await pool.query("UPDATE leaderboard_submission SET status='rejected',error='verification_retry_limit',replay='null'::jsonb WHERE status='processing' AND attempts>=3 AND locked_at < now()-interval '1 minute'");
  }
} finally { await pool.end(); }
