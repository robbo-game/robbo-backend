import { symbolKinds, type Entity, type LevelData } from './model';

export interface WorldState {
  tick: number; remaining: number; collected: number; keys: number; ammo: number;
  status: 'playing' | 'dead' | 'won'; statusTicks: number; teleportTicks: number;
  magnetOwner?: number; deathPresentationPending: boolean; nextId: number;
  robot: Entity; entities: Entity[];
  blasts: { x: number; y: number; phase: number; born: number }[];
  lasers: { owner: Entity; direction: number; x: number; y: number; parts: Entity[]; returning: boolean; born: number }[];
}

/** Treat browser records as untrusted: reject invalid state before touching a live world. */
export function readWorldState(raw: unknown, level: LevelData): WorldState {
  const fail = (): never => { throw Error('Invalid saved world'); };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value as Record<string, unknown>;
  };
  const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
    return value as number;
  };
  const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') fail(); return value as boolean; };
  const list = (value: unknown, limit: number): unknown[] => { if (!Array.isArray(value) || value.length > limit) fail(); return value as unknown[]; };
  const kinds = new Set([...Object.values(symbolKinds), 'shot', 'flame', 'beam', 'smoke', 'impact', 'blast']);
  const entity = (value: unknown): Entity => {
    const e = record(value);
    if (!kinds.has(e.kind as string) || typeof e.symbol !== 'string' || e.symbol.length > 4) fail();
    integer(e.id, 1); integer(e.x, 0, level.width - 1); integer(e.y, 0, level.height - 1);
    for (const name of ['age', 'frame', 'rotationInterval', 'group', 'index', 'expires', 'dying']) integer(e[name]);
    integer(e.countdown, -1); integer(e.direction, 0, 3); integer(e.fireDirection, 0, 3); integer(e.fireType, 0, 2);
    for (const name of ['alive', 'shooting', 'moving', 'rotating', 'motion', 'spawned']) boolean(e[name]);
    if (e.hand !== undefined && e.hand !== -1 && e.hand !== 1) fail();
    if (e.observer !== undefined) integer(e.observer, 0, 3);
    if (e.owner !== undefined) integer(e.owner, 1);
    if (e.after !== undefined && !kinds.has(e.after as string)) fail();
    return { ...e } as unknown as Entity;
  };
  const data = record(raw), cells = level.width * level.height;
  const entities = list(data.entities, cells).map(entity), robot = entity(data.robot);
  if (robot.kind !== 'robot') fail();
  const ids = new Set<number>(), positions = new Set<string>();
  for (const e of entities) {
    const position = `${e.x},${e.y}`;
    if (!e.alive || ids.has(e.id) || positions.has(position)) fail();
    ids.add(e.id); positions.add(position);
  }
  if (!['playing', 'dead', 'won'].includes(data.status as string)) fail();
  const liveRobots = entities.filter(e => e.kind === 'robot');
  if (data.status === 'dead') {
    if (robot.alive || liveRobots.length || ids.has(robot.id)) fail();
  } else if (!robot.alive || liveRobots.length !== 1 || JSON.stringify(liveRobots[0]) !== JSON.stringify(robot)) fail();
  if (data.magnetOwner !== undefined) {
    integer(data.magnetOwner, 1);
    if (!entities.some(e => e.id === data.magnetOwner && e.kind === 'magnet')) fail();
  }
  const tick = integer(data.tick), nextId = integer(data.nextId, 1);
  const blasts = list(data.blasts, cells).map(value => {
    const b = record(value);
    return { x: integer(b.x, 0, level.width - 1), y: integer(b.y, 0, level.height - 1), phase: integer(b.phase, 0, 1), born: integer(b.born, 0, tick) };
  });
  const lasers = list(data.lasers, cells).map(value => {
    const l = record(value);
    return { owner: entity(l.owner), parts: list(l.parts, cells).map(entity), direction: integer(l.direction, 0, 3),
      x: integer(l.x, -1, level.width), y: integer(l.y, -1, level.height), returning: boolean(l.returning), born: integer(l.born, 0, tick) };
  });
  for (const e of [robot, ...entities, ...lasers.flatMap(l => [l.owner, ...l.parts])]) if (e.id >= nextId) fail();
  for (const reference of lasers.flatMap(l => [l.owner, ...l.parts])) {
    const live = entities.find(e => e.id === reference.id);
    if (reference.alive && (!live || JSON.stringify(live) !== JSON.stringify(reference))) fail();
    if (!reference.alive && live) fail();
  }
  return { tick, nextId, entities, robot, blasts, lasers, status: data.status as WorldState['status'],
    remaining: integer(data.remaining), collected: integer(data.collected), keys: integer(data.keys, 0, 99), ammo: integer(data.ammo, 0, 99),
    statusTicks: integer(data.statusTicks), teleportTicks: integer(data.teleportTicks, 0, 4),
    magnetOwner: data.magnetOwner as number | undefined, deathPresentationPending: boolean(data.deathPresentationPending) };
}
