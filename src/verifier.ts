import { Worker } from 'node:worker_threads';
import type { VerifiedResult } from './verification.js';
import type { SavedAttempt } from '../vendor/robbo/src/application/saved-attempt';
let active = 0;
export function verifyInWorker(replay: unknown): Promise<VerifiedResult> {
  return run<VerifiedResult>('replay',replay);
}
export function validateCheckpointInWorker(attempt: unknown): Promise<SavedAttempt> {
  return run<SavedAttempt>('checkpoint',attempt);
}
function run<T>(operation: string, data: unknown): Promise<T> {
  if (active >= 4) return Promise.reject(Error('verification_busy'));
  active++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./verifier-worker.js', import.meta.url), { workerData: { operation,data }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(Error('verification_timeout')); }, 10000);
    const cleanup = (): void => { clearTimeout(timer); void worker.terminate(); };
    worker.once('message', (message: { result?: T; error?: string }) => { cleanup(); if (message.result) resolve(message.result); else reject(Error(message.error ?? 'verification_failed')); });
    worker.once('error', () => { cleanup(); reject(Error('verification_failed')); });
    worker.once('exit', () => { clearTimeout(timer); reject(Error('verification_failed')); });
  }).finally(() => { active--; }) as Promise<T>;
}
