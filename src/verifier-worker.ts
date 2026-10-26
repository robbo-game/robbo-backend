import { parentPort, workerData } from 'node:worker_threads';
import { packs } from '../vendor/robbo/src/generated/packs';
import { verifyReplay } from './verification.js';
try { parentPort!.postMessage({ result: verifyReplay(workerData, packs) }); }
catch { parentPort!.postMessage({ error: 'invalid_or_incompatible_replay' }); }
