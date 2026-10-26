import { GameSession } from '../vendor/robbo/src/application/game-session';
import { checkpoint, digest, REPLAY_ENGINE, type Replay } from '../vendor/robbo/src/application/replay';
import type { Pack } from '../vendor/robbo/src/engine/model';
export interface VerifiedResult { campaign: string; planet: number; engine: string; campaignHash: string; elapsedTicks: number; deaths: number }
export function verifyReplay(data: Replay, packs: Pack[]): VerifiedResult {
  const pack = packs.find(p => p.id === data?.pack);
  if (data?.version !== 1 || data.engine !== REPLAY_ENGINE || data.rules !== 'java-v1' || !pack || data.packHash !== digest(pack)) throw Error('unsupported_replay');
  if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 0xffffffff || !Number.isInteger(data.planet) || data.planet < 1 || data.planet > pack.levels.length || !Array.isArray(data.frames) || !data.frames.length || data.frames.length > 100000) throw Error('invalid_bounds');
  const session = new GameSession(pack, data.seed); session.selectPlanet(data.planet);
  let deaths = 0, elapsedTicks = 0, finished = false;
  for (const [tick, frame] of data.frames.entries()) {
    if (!frame || frame.tick !== tick || !Array.isArray(frame.actions) || frame.actions.length > 32) throw Error('invalid_frame');
    session.world.drainEvents();
    for (const action of frame.actions) {
      if (!action || typeof action !== 'object') throw Error('invalid_action');
      if (action.type === 'command') {
        if (!Number.isInteger(action.direction) || action.direction < 0 || action.direction > 3 || typeof action.fire !== 'boolean' || (action.aimOnly !== undefined && typeof action.aimOnly !== 'boolean') || (action.aimOnly && action.fire)) throw Error('invalid_command');
        session.command(action.direction, action.fire, action.aimOnly);
      } else if (action.type === 'pause') session.togglePause();
      else if (action.type === 'restart') { if (!finished && session.world.status !== 'dead') deaths++; session.restart(); }
      else if (action.type === 'retry') { if (!finished && session.world.status !== 'dead') deaths++; session.retry(); }
      else if (action.type === 'start') session.start();
      else throw Error('invalid_action');
    }
    const world = session.world, beforeStatus = world.status, eventsBefore = world.events.length;
    // The clock counts every replay frame, including pauses and death presentation;
    // restarts cannot reset it. A replay begins on a fresh started planet.
    if (!finished) elapsedTicks++;
    session.step();
    if (!finished && beforeStatus !== 'dead' && world.status === 'dead') deaths++;
    const events = session.world === world ? world.events.slice(eventsBefore) : session.world.events;
    if (frame.checkpoint !== checkpoint(session) || frame.events !== digest(events)) throw Error('replay_diverged');
    session.world.assertConsistent();
    finished ||= world.status === 'won';
  }
  if (!finished) throw Error('planet_not_completed');
  return { campaign: pack.id, planet: data.planet, engine: REPLAY_ENGINE, campaignHash: digest(pack), elapsedTicks, deaths };
}
