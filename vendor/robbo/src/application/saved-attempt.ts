import { GameSession } from './game-session';
import { digest } from './replay';
import { ENGINE_VERSION } from '../engine/rules-version';
import type { Pack } from '../engine/model';
import type { WorldState } from '../engine/world-state';

export interface SavedAttempt {
  version: 1; engine: string; savedAt: number; pack: string; packHash: string;
  planet: number; seed: number; randomState: number; started: boolean; completed: boolean;
  world: WorldState;
}
const packHashes = new WeakMap<Pack, string>();
function packHash(pack: Pack): string {
  let hash = packHashes.get(pack);
  if (!hash) { hash = digest(pack); packHashes.set(pack, hash); }
  return hash;
}
export function saveAttempt(session: GameSession, savedAt = Date.now()): SavedAttempt {
  return { version: 1, engine: ENGINE_VERSION, savedAt, pack: session.pack.id, packHash: packHash(session.pack),
    planet: session.planet, seed: session.initialSeed, randomState: session.randomState,
    started: session.started, completed: session.completed, world: session.world.snapshot() };
}
export function restoreAttempt(raw: unknown, packs: Pack[]): GameSession {
  if (!raw || typeof raw !== 'object') throw Error('Invalid saved attempt');
  const data = raw as SavedAttempt;
  const pack = packs.find(p => p.id === data.pack);
  const uint = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
  if (data.version !== 1 || data.engine !== ENGINE_VERSION || !pack || data.packHash !== packHash(pack)) throw Error('Incompatible saved attempt');
  if (!Number.isSafeInteger(data.savedAt) || data.savedAt < 0 || !uint(data.seed) || !uint(data.randomState)
    || !Number.isInteger(data.planet) || data.planet < 1 || data.planet > pack.levels.length
    || typeof data.started !== 'boolean' || typeof data.completed !== 'boolean') throw Error('Invalid saved attempt');
  const session = new GameSession(pack, data.seed); session.selectPlanet(data.planet);
  session.world.restore(data.world); session.restoreRandomState(data.randomState);
  if (data.completed && (data.planet !== pack.levels.length || session.world.status !== 'won')) throw Error('Invalid completed attempt');
  session.started = data.started; session.completed = data.completed;
  // Opening a saved board never starts enemies before the player chooses Resume.
  session.paused = session.started && !session.completed;
  return session;
}
