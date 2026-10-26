import { parentPort, workerData } from 'node:worker_threads';
import { packs } from '../vendor/robbo/src/generated/packs';
import { verifyReplay } from './verification.js';
import { validateCheckpoint } from './checkpoint-validation.js';
try { parentPort!.postMessage({ result: workerData.operation === 'checkpoint' ? validateCheckpoint(workerData.data, packs) : verifyReplay(workerData.data, packs) }); }
catch { parentPort!.postMessage({ error: 'invalid_or_incompatible_replay' }); }
