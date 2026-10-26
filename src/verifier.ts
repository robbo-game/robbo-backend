import { Worker } from 'node:worker_threads';
import type { VerifiedResult } from './verification.js';
export function verifyInWorker(replay: unknown): Promise<VerifiedResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./verifier-worker.js', import.meta.url), { workerData: replay, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(Error('verification_timeout')); }, 10000);
    const cleanup = (): void => { clearTimeout(timer); void worker.terminate(); };
    worker.once('message', (message: { result?: VerifiedResult; error?: string }) => { cleanup(); if (message.result) resolve(message.result); else reject(Error(message.error ?? 'verification_failed')); });
    worker.once('error', () => { cleanup(); reject(Error('verification_failed')); });
    worker.once('exit', () => { clearTimeout(timer); reject(Error('verification_failed')); });
  });
}
