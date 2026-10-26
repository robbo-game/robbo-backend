import { ENGINE_VERSION } from '../engine/rules-version';
import { GameSession } from './game-session';
import type { Direction, Pack } from '../engine/model';
// Rule changes alter simulation outcomes; reject recordings of older engines.
export const REPLAY_ENGINE = ENGINE_VERSION;
const MAX_FRAMES = 100000, MAX_ACTIONS = 32;
export type ReplayAction = { type: 'command'; direction: Direction; fire: boolean; aimOnly?: boolean } | { type: 'pause' | 'restart' | 'retry' | 'start' };
interface Frame { tick: number; actions: ReplayAction[]; checkpoint: string; events: string }
export interface Replay { version: 1; engine: string; rules: string; pack: string; packHash: string; planet: number; seed: number; frames: Frame[] }
export function digest(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function checkpoint(session: GameSession): string {
  const w = session.world;
  return digest({ planet: session.planet, completed: session.completed, paused: session.paused, started: session.started,
    tick: w.tick, status: w.status, statusTicks: w.statusTicks, teleport: w.teleportTicks, magnet: w.magnetOwner,
    ammo: w.ammo, keys: w.keys, remaining: w.remaining, collected: w.collected,
    entities: [...w.entities.values()].sort((a,b) => a.id-b.id), blasts: w.blasts,
    lasers: w.lasers.map(l => ({ owner: l.owner.id, direction: l.direction, x: l.x, y: l.y, parts: l.parts.map(p => p.id), returning: l.returning, born: l.born })) });
}
export class ReplayRecorder {
  readonly data: Replay;
  private pending: ReplayAction[] = [];
  constructor(readonly session: GameSession) {
    if (session.world.tick !== 0 || !session.started || session.paused) throw Error('Start recording on a fresh, started planet');
    this.data = { version: 1, engine: REPLAY_ENGINE, rules: 'java-v1', pack: session.pack.id,
      packHash: digest(session.pack), planet: session.planet, seed: session.initialSeed, frames: [] };
  }
  action(action: ReplayAction): void {
    if (this.pending.length >= MAX_ACTIONS) throw Error('Too many replay actions in one tick');
    this.pending.push(action); applyAction(this.session, action);
  }
  step(): void {
    if (this.data.frames.length >= MAX_FRAMES) throw Error('Replay tick limit reached');
    if (this.session.pack.id !== this.data.pack) throw Error('Recording campaign changed');
    const world = this.session.world, eventsBefore = world.events.length;
    this.session.step();
    const events = this.session.world === world ? world.events.slice(eventsBefore) : this.session.world.events;
    this.data.frames.push({ tick: this.data.frames.length, actions: this.pending.splice(0), checkpoint: checkpoint(this.session), events: digest(events) });
  }
  export(): string { return JSON.stringify(this.data); }
}
function applyAction(session: GameSession, action: ReplayAction): void {
  if (action.type === 'command') session.command(action.direction, action.fire, action.aimOnly);
  else if (action.type === 'pause') session.togglePause();
  else if (action.type === 'restart') session.restart();
  else if (action.type === 'retry') session.retry();
  else session.start();
}
export function playReplay(text: string, packs: Pack[]): GameSession {
  if (text.length > 20000000) throw Error('Replay file is too large');
  const data = JSON.parse(text) as Replay;
  const pack = packs.find(p => p.id === data?.pack);
  if (data?.version !== 1 || data.engine !== REPLAY_ENGINE || data.rules !== 'java-v1' || !pack || data.packHash !== digest(pack)) throw Error('Incompatible replay version, rules or campaign');
  if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff || !Number.isInteger(data.planet) || data.planet < 1 || data.planet > pack.levels.length || !Array.isArray(data.frames) || data.frames.length > MAX_FRAMES) throw Error('Invalid replay bounds');
  const session = new GameSession(pack, data.seed); session.selectPlanet(data.planet);
  for (const [tick, frame] of data.frames.entries()) {
    if (!frame || frame.tick !== tick || !Array.isArray(frame.actions) || frame.actions.length > MAX_ACTIONS) throw Error(`Invalid replay frame ${tick}`);
    session.world.drainEvents();
    for (const action of frame.actions) {
      if (!action || !['command', 'pause', 'restart', 'retry', 'start'].includes(action.type)) throw Error(`Invalid replay action at tick ${tick}`);
      if (action.type === 'command' && (!Number.isInteger(action.direction) || action.direction < 0 || action.direction > 3 || typeof action.fire !== 'boolean' || (action.aimOnly !== undefined && typeof action.aimOnly !== 'boolean') || (action.aimOnly === true && action.fire))) throw Error(`Invalid replay command at tick ${tick}`);
      applyAction(session, action);
    }
    const world = session.world, eventsBefore = world.events.length;
    session.step();
    const events = session.world === world ? world.events.slice(eventsBefore) : session.world.events;
    if (frame.checkpoint !== checkpoint(session) || frame.events !== digest(events)) throw Error(`Replay diverged at tick ${tick}: state or events differ`);
    session.world.assertConsistent();
  }
  return session;
}
