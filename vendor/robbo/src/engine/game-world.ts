import { readWorldState, type WorldState } from './world-state';
import { requireSupportedSymbols } from './level-symbols';
import { inverse, kindSymbols, symbolKinds, vectors } from './model';
import type { Command, Direction, Entity, GameEvent, Kind, LevelData, SoundName } from './model';

export const shotTargets = new Set<Kind>(['robot', 'bear', 'worm', 'bird', 'eyes', 'river', 'bomb', 'question', 'sand', 'ammo']);
export const blastTargets = new Set<Kind>([...shotTargets, 'box', 'screw', 'key', 'door', 'ship', 'stop', 'shot', 'flame', 'beam']);
export const riverTargets = new Set<Kind>(['robot', 'shot', 'flame', 'beam', 'smoke', 'impact', 'blast', 'question', 'screw', 'cannon', 'bird', 'worm', 'bear', 'eyes', 'bomb', 'momentum', 'box', 'key', 'ship', 'ammo', 'sand', 'stop']);
const pushable = new Set<Kind>(['box', 'momentum', 'bomb', 'question', 'ship', 'cannon']);
const questionPool: Kind[] = ['river', 'bomb', 'question', 'screw', 'magnet', 'key', 'sand', 'box', 'momentum', 'eyes', 'bird', 'ammo', 'bear', 'worm', 'cannon'];
interface Blast { x: number; y: number; phase: number; born: number }
interface Laser { owner: Entity; direction: Direction; x: number; y: number; parts: Entity[]; returning: boolean; born: number }

/** The grid is authoritative. Rendering never creates, moves or removes an entity. */
export class GameWorld {
  readonly grid: (Entity | undefined)[];
  readonly entities = new Map<number, Entity>();
  readonly events: GameEvent[] = [];
  readonly blasts: Blast[] = [];
  readonly lasers: Laser[] = [];
  robot!: Entity;
  readonly startX: number;
  readonly startY: number;
  tick = 0;
  remaining = 0;
  collected = 0;
  keys = 0;
  ammo = 0;
  status: 'playing' | 'dead' | 'won' = 'playing';
  statusTicks = 0;
  teleportTicks = 0;
  magnetOwner?: number;
  private deathPresentationPending = false;
  private nextId = 1;
  private pending?: Command;

  constructor(readonly level: LevelData, private readonly random: () => number = Math.random) {
    requireSupportedSymbols(level.rows, 'java', 'Java campaign', level.number);
    this.grid = new Array(level.width * level.height);
    for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
      const symbol = level.rows[y][x];
      if (symbol === '.') continue;
      const kind = symbolKinds[symbol];
      if (!kind) throw Error(`Unsupported tile ${symbol} on planet ${level.number}`);
      const e = this.spawn(kind, x, y, symbol, level.options[`${x},${y}`]);
      if (kind === 'robot') this.robot = e;
      if (kind === 'screw') this.remaining++;
    }
    if (!this.robot) throw Error('A planet requires Robbo');
    this.startX = this.robot.x; this.startY = this.robot.y;
    if (this.remaining === 0) this.emit('exit-open');
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.level.width && y < this.level.height;
  }
  at(x: number, y: number): Entity | undefined { return this.inBounds(x, y) ? this.grid[y * this.level.width + x] : undefined; }
  free(x: number, y: number): boolean { return this.inBounds(x, y) && !this.at(x, y); }
  next(e: { x: number; y: number }, direction: Direction): [number, number] {
    const v = vectors[direction]; return [e.x + v[0], e.y + v[1]];
  }
  emit(type: SoundName): void { this.events.push({ type, tick: this.tick }); }
  drainEvents(): GameEvent[] { return this.events.splice(0); }
  command(direction: Direction, fire = false, aimOnly = false): void {
    if (this.status === 'playing' && !this.teleportTicks) this.pending = aimOnly ? { direction, fire: false, aimOnly: true } : { direction, fire };
  }
  clearInput(): void { this.pending = undefined; }

  spawn(kind: Kind, x: number, y: number, symbol = kindSymbols[kind] || '', options: number[] = []): Entity {
    if (!this.inBounds(x, y)) throw Error(`Cannot spawn ${kind} outside the map: ${x},${y}`);
    if (this.at(x, y)) throw Error(`Cannot overwrite ${this.at(x, y)?.kind} with ${kind}: ${x},${y}`);
    const e: Entity = {
      id: this.nextId++, kind, symbol, x, y, direction: 1, age: 0, frame: 0, alive: true,
      fireDirection: 0, shooting: false, fireType: 0, moving: false, rotating: false,
      countdown: 5, rotationInterval: 10 + Math.floor(this.random() * 20),
      group: options[0] || 0, index: options[1] || 0, motion: false, expires: 0, dying: 0, spawned: false
    };
    if (['bear', 'worm', 'magnet', 'river'].includes(kind)) e.direction = (options[0] ?? (kind === 'river' ? 0 : kind === 'magnet' ? 0 : 1)) as Direction;
    if (kind === 'bird') {
      e.direction = (options[0] ?? 1) as Direction; e.fireDirection = (options[1] ?? 1) as Direction; e.shooting = options[2] === 1;
    }
    if (kind === 'cannon') {
      e.fireDirection = (options[0] ?? 0) as Direction; e.direction = (options[1] ?? 0) as Direction;
      e.fireType = options[2] || 0; e.moving = options[3] === 1; e.rotating = options[4] === 1;
      if (e.rotating) e.moving = false;
      if ((e.moving || e.rotating) && e.fireType === 1) e.fireType = 0;
    }
    this.entities.set(e.id, e); this.grid[y * this.level.width + x] = e;
    return e;
  }
  remove(e: Entity): void {
    if (!e.alive) return;
    if (this.at(e.x, e.y) === e) this.grid[e.y * this.level.width + e.x] = undefined;
    e.alive = false; this.entities.delete(e.id);
    if (this.magnetOwner === e.id) this.magnetOwner = undefined;
  }
  move(e: Entity, x: number, y: number): boolean {
    if (!e.alive || !this.free(x, y)) return false;
    if (this.at(e.x, e.y) === e) this.grid[e.y * this.level.width + e.x] = undefined;
    e.x = x; e.y = y; this.grid[y * this.level.width + x] = e; return true;
  }
  effect(kind: 'smoke' | 'impact' | 'blast', x: number, y: number, after?: Kind): Entity | undefined {
    if (!this.free(x, y)) return;
    const e = this.spawn(kind, x, y); e.expires = this.tick + (kind === 'impact' ? 2 : kind === 'blast' ? 4 : 3); e.after = after; return e;
  }
  /**
   * Finish the current attempt without advancing simulation rules any further.
   * The resulting blast cells are a deterministic lifecycle presentation, not
   * bomb damage: every non-wall object is removed exactly once.
   */
  beginDeathPresentation(): void {
    if (this.status !== 'playing') return;
    this.status = 'dead'; this.statusTicks = 0; this.clearInput(); this.magnetOwner = undefined; this.teleportTicks = 0;
    this.remove(this.robot); this.effect('smoke', this.robot.x, this.robot.y); this.emit('kill'); this.deathPresentationPending = true;
  }
  private markRemainingObjectsForDeath(): void {
    for (const e of [...this.entities.values()]) {
      if (e.kind === 'wall' || e.kind === 'smoke' || e.kind === 'impact' || e.kind === 'blast') continue;
      const { x, y } = e;
      this.remove(e); this.effect('blast', x, y);
    }
    this.blasts.length = 0; this.lasers.length = 0;
  }
  killRobot(): void {
    if (this.status !== 'playing') return;
    this.beginDeathPresentation();
  }
  damage(e: Entity, attack: 'shot' | 'blast' | 'river' | 'momentum'): boolean {
    if (!e.alive) return false;
    const targets = attack === 'river' ? riverTargets : attack === 'blast' ? blastTargets : shotTargets;
    if (!targets.has(e.kind)) return false;
    if (e.kind === 'robot') { this.killRobot(); return true; }
    if (e.kind === 'river' && attack !== 'river') {
      if (e.dying) return true;
      e.dying = this.tick + 6; return true;
    }
    const { x, y, kind } = e;
    this.remove(e);
    if (attack === 'river') return true; // Absorption is not a bomb detonation or a pickup.
    if (kind === 'bomb') {
      this.effect('blast', x, y); this.blasts.push({ x, y, phase: 0, born: this.tick }); this.emit('bomb');
    } else if (kind === 'question') {
      if (attack === 'blast') this.effect('blast', x, y);
      else {
        const index = Math.floor(this.random() * (questionPool.length + 1));
        this.effect('smoke', x, y, questionPool[index]);
      }
    } else this.effect(attack === 'blast' ? 'blast' : 'smoke', x, y);
    return true;
  }

  step(): void {
    this.tick++;
    const snapshot = [...this.entities.values()];
    if (this.status === 'dead' && this.deathPresentationPending) {
      this.deathPresentationPending = false; this.markRemainingObjectsForDeath();
    }
    for (const e of snapshot) { e.age++; if (e.kind !== 'robot') e.frame = Math.floor(e.age / 2) % 2; }
    this.updateEffects(snapshot);
    if (this.status !== 'playing') { this.statusTicks++; this.clearInput(); return; }
    this.checkAdjacency();
    if (this.status !== 'playing') { this.clearInput(); return; }
    this.updateBlasts();
    for (const e of snapshot) if (e.alive && (e.kind === 'shot' || e.kind === 'flame')) this.updateProjectile(e);
    this.updateLasers();
    if (this.status !== 'playing') { this.clearInput(); return; }
    this.updateRivers(snapshot);
    for (const e of snapshot) {
      if (!e.alive || this.status !== 'playing') continue;
      switch (e.kind) {
        case 'bird':
          if (e.shooting) this.updateFiring(e);
          this.bounce(e);
          if (this.random() < 0.002) this.emit('bird');
          break;
        case 'bear': case 'worm':
          this.wallFollow(e);
          if (e.kind === 'worm' && this.random() < 0.002) this.emit('worm');
          break;
        case 'eyes': this.chaseJavaEyes(e); break;
        case 'cannon':
          if (e.rotating && e.age % e.rotationInterval === 0) e.fireDirection = Math.floor(this.random() * 4) as Direction;
          this.updateFiring(e);
          if (e.moving) this.bounce(e);
          break;
        case 'momentum': this.updateMomentum(e); break;
      }
    }
    this.checkAdjacency();
    if (this.status !== 'playing') { this.clearInput(); return; }
    if (this.teleportTicks) { this.teleportTicks--; this.clearInput(); return; }
    this.updateMagnets(snapshot);
    if (this.status !== 'playing') { this.clearInput(); return; }
    const command = this.pending; this.clearInput();
    if (command && !this.magnetOwner) {
      this.robot.direction = command.direction;
      if (command.fire) {
        if (this.ammo > 0) { this.ammo--; this.fire(this.robot, command.direction, 0); this.emit('shoot'); }
      } else if (!command.aimOnly) this.moveRobot(command.direction);
    }
    this.checkAdjacency();
  }

  private updateEffects(snapshot: Entity[]): void {
    for (const e of snapshot) {
      if (!e.alive || !e.expires || this.tick < e.expires) continue;
      this.remove(e);
      if (e.after && this.status === 'playing' && this.free(e.x, e.y)) {
        const options = e.after === 'cannon' ? [2, 0, 0, 0, 1, 1] : e.after === 'bird' ? [3, 1, 1] : [2];
        this.spawn(e.after, e.x, e.y, undefined, options);
      }
    }
  }
  private updateBlasts(): void {
    const phases = [[[ -1, 1 ], [0, 1], [1, 1], [1, 0]], [[-1, 0], [-1, -1], [0, -1], [1, -1]]];
    for (const b of [...this.blasts]) {
      if (b.born >= this.tick) continue;
      for (const [dx, dy] of phases[b.phase]) {
        const x = b.x + dx, y = b.y + dy;
        if (!this.inBounds(x, y)) continue;
        const target = this.at(x, y);
        if (target) this.damage(target, 'blast'); else this.effect('blast', x, y);
      }
      b.phase++;
      if (b.phase === 2) this.blasts.splice(this.blasts.indexOf(b), 1);
    }
  }
  private moveRobot(direction: Direction): void {
    const [x, y] = this.next(this.robot, direction);
    if (!this.inBounds(x, y)) return;
    const e = this.at(x, y);
    if (e) {
      if (e.kind === 'mirror') { this.teleport(e); return; }
      if (e.kind === 'ship' && this.remaining === 0) {
        this.status = 'won'; this.statusTicks = 0; this.emit('end'); this.clearInput(); return;
      }
      if (['shot', 'flame', 'beam', 'river'].includes(e.kind)) { this.killRobot(); return; }
      if (['bird', 'bear', 'worm', 'eyes'].includes(e.kind)) { this.killRobot(); return; }
      if (e.kind === 'magnet' && this.next(e, e.direction).every((v, i) => v === [this.robot.x, this.robot.y][i])) { this.killRobot(); return; }
      if (e.kind === 'door') {
        if (this.keys > 0) { this.keys--; this.remove(e); this.emit('door'); }
        return;
      }
      if (['screw', 'key', 'ammo', 'stop'].includes(e.kind)) {
        if (e.kind === 'screw') {
          const wasRequired = this.remaining > 0;
          this.remaining = Math.max(0, this.remaining - 1); this.collected++;
          this.emit(wasRequired && this.remaining === 0 ? 'exit-open' : 'screw');
        }
        if (e.kind === 'key') { this.keys = Math.min(99, this.keys + 1); this.emit('key'); }
        if (e.kind === 'ammo') { this.ammo = Math.min(99, this.ammo + 9); this.emit('ammo'); }
        this.remove(e);
      } else if (pushable.has(e.kind)) {
        const [px, py] = this.next(e, direction);
        if (!this.move(e, px, py)) return;
        if (e.kind === 'momentum') { e.motion = true; e.direction = direction; e.age = 1; }
        this.emit('box');
      } else return;
    }
    if (this.move(this.robot, x, y)) { this.robot.frame = 1 - this.robot.frame; this.emit('walk'); }
  }
  private bounce(e: Entity): void {
    const [x, y] = this.next(e, e.direction); const target = this.at(x, y);
    if (target?.kind === 'robot') { this.killRobot(); return; }
    if (!this.move(e, x, y)) e.direction = inverse(e.direction);
  }
  private wallFollow(e: Entity): void {
    const turn = (d: Direction) => ((d + (e.hand ?? 1) + 4) % 4) as Direction;
    if (e.hand === undefined) {
      const side = ((e.direction + 3) % 4) as Direction;
      const [x, y] = this.next(e, side);
      e.hand = this.free(x, y) ? -1 : 1; e.observer = inverse(turn(e.direction));
    }
    if (e.age % 2 !== 0) return;
    const observer = e.observer ?? inverse(turn(e.direction));
    const [ox, oy] = this.next(e, observer);
    if (!this.free(ox, oy)) {
      const t = turn(observer); const [x, y] = this.next(e, t);
      if (!this.free(x, y)) e.observer = t; else this.move(e, x, y);
    } else { this.move(e, ox, oy); e.observer = inverse(turn(observer)); }
  }
  /**
   * Compatibility rule for every shipped Java campaign.  This is deliberately
   * deterministic greedy steering, rather than the stochastic GNU butterfly
   * behaviour; see docs/gameplay-parity.md.
   */
  private chaseJavaEyes(e: Entity): void {
    if (e.age % 3) return;
    const distance = (x: number, y: number) => (x - this.robot.x) ** 2 + (y - this.robot.y) ** 2;
    let best = distance(e.x, e.y), target: [number, number] = [e.x, e.y];
    for (const d of [2, 0, 1, 3] as Direction[]) {
      const [x, y] = this.next(e, d); const value = distance(x, y);
      if (this.free(x, y) && value < best) { best = value; target = [x, y]; }
    }
    if (target[0] !== e.x || target[1] !== e.y) this.move(e, ...target);
  }
  private checkAdjacency(): void {
    if (!this.robot.alive || this.teleportTicks) return;
    for (const d of [0, 1, 2, 3] as Direction[]) {
      const target = this.at(...this.next(this.robot, d));
      if (target && ['bird', 'bear', 'worm', 'eyes'].includes(target.kind)) { this.killRobot(); return; }
    }
  }
  private updateMomentum(e: Entity): void {
    if (!e.motion || e.age % 2) return;
    const [x, y] = this.next(e, e.direction); const target = this.at(x, y);
    if (target) { e.motion = false; this.damage(target, 'momentum'); }
    else if (!this.move(e, x, y)) e.motion = false;
  }
  private updateMagnets(snapshot: Entity[]): void {
    let owner = this.magnetOwner && this.entities.get(this.magnetOwner);
    const sees = (e: Entity) => {
      let [x, y] = this.next(e, e.direction);
      while (this.inBounds(x, y)) {
        const target = this.at(x, y);
        if (target) return target === this.robot;
        [x, y] = this.next({ x, y }, e.direction);
      }
      return false;
    };
    if (owner && (!owner.alive || !sees(owner))) owner = undefined;
    if (!owner) owner = snapshot.find(e => e.alive && e.kind === 'magnet' && sees(e));
    if (!owner) { this.magnetOwner = undefined; return; }
    if (this.magnetOwner !== owner.id) this.emit('magnet');
    this.magnetOwner = owner.id; this.clearInput();
    const [x, y] = this.next(this.robot, inverse(owner.direction));
    if (this.at(x, y) === owner) this.killRobot();
    else { this.move(this.robot, x, y); this.robot.frame = 1 - this.robot.frame; }
  }
  private teleport(source: Entity): void {
    const mirrors = [...this.entities.values()].filter(e => e.kind === 'mirror' && e.group === source.group).sort((a, b) => a.index - b.index || a.id - b.id);
    const partners = [...mirrors.filter(e => e.index > source.index), ...mirrors.filter(e => e.index <= source.index)];
    const from: Direction = this.robot.x < source.x ? 2 : this.robot.x > source.x ? 0 : this.robot.y < source.y ? 3 : 1;
    const preferences: Direction[][] = [[2, 3, 1, 0], [3, 0, 2, 1], [0, 1, 3, 2], [1, 2, 0, 3]];
    for (const partner of partners) for (const d of preferences[from]) {
      const [x, y] = this.next(partner, d);
      if (!this.free(x, y)) continue;
      const oldX = this.robot.x, oldY = this.robot.y;
      this.move(this.robot, x, y); this.robot.direction = d;
      this.effect('smoke', oldX, oldY); this.teleportTicks = 4; this.magnetOwner = undefined; this.clearInput(); this.emit('teleport'); return;
    }
  }

  fire(source: Entity, direction: Direction, fireType = 0): void {
    const [x, y] = this.next(source, direction);
    if (!this.inBounds(x, y)) { this.effect('impact', source.x, source.y); return; }
    const target = this.at(x, y);
    if (target) { this.damage(target, 'shot'); return; }
    if (fireType === 1) {
      if (this.lasers.some(l => l.owner === source)) return;
      this.lasers.push({ owner: source, direction, x, y, parts: [], returning: false, born: this.tick });
    } else {
      const e = this.spawn(fireType === 2 ? 'flame' : 'shot', x, y); e.direction = direction; e.index = 0;
    }
  }
  private updateFiring(e: Entity): void {
    if (e.countdown-- > 0) return;
    e.countdown = Math.floor(this.random() * 50);
    if (e.fireType === 1 && this.lasers.some(l => l.owner === e)) return;
    this.fire(e, e.fireDirection, e.fireType); this.emit('gun');
  }
  private updateProjectile(e: Entity): void {
    const [x, y] = this.next(e, e.direction); const target = this.at(x, y); const oldX = e.x, oldY = e.y;
    if (!this.inBounds(x, y)) { this.remove(e); this.effect('impact', oldX, oldY); return; }
    if (e.kind === 'shot') {
      if (target) {
        this.remove(e); const damaged = this.damage(target, 'shot'); if (!damaged) this.effect('impact', oldX, oldY);
      } else this.move(e, x, y);
      return;
    }
    if (target && target.kind !== 'flame') {
      if (!this.damage(target, 'shot')) { this.remove(e); this.effect('impact', oldX, oldY); return; }
      const replacement = this.at(x, y);
      // A flame passes through ordinary destruction, but preserves a newly detonating bomb/question effect.
      if (replacement && replacement.kind === 'smoke' && !replacement.after) this.remove(replacement);
      if (this.at(x, y)) { this.remove(e); return; }
    } else if (target?.kind === 'flame') return;
    if (this.move(e, x, y) && !e.spawned) {
      e.spawned = true;
      if (e.index < 6 && this.free(oldX, oldY)) {
        const next = this.spawn('flame', oldX, oldY); next.direction = e.direction; next.index = e.index + 1;
      }
    }
  }
  private updateLasers(): void {
    for (const laser of [...this.lasers]) {
      if (laser.born >= this.tick) continue;
      if (!laser.owner.alive) { for (const part of laser.parts) this.remove(part); this.lasers.splice(this.lasers.indexOf(laser), 1); continue; }
      if (!laser.returning) {
        const target = this.at(laser.x, laser.y);
        if (!this.inBounds(laser.x, laser.y) || target) {
          if (target) this.damage(target, 'shot'); laser.returning = true;
        } else {
          const part = this.spawn('beam', laser.x, laser.y); part.direction = laser.direction; part.owner = laser.owner.id;
          laser.parts.push(part); [laser.x, laser.y] = this.next(part, laser.direction);
        }
      } else {
        const part = laser.parts.pop(); if (part) this.remove(part);
        if (laser.parts.length === 0) {
          const [x, y] = this.next(laser.owner, laser.direction); this.effect('impact', x, y);
          this.lasers.splice(this.lasers.indexOf(laser), 1);
        }
      }
    }
  }
  private updateRivers(snapshot: Entity[]): void {
    const rivers = snapshot.filter(e => e.alive && e.kind === 'river');
    const moves: { e: Entity; x: number; y: number }[] = [];
    for (const e of rivers) {
      if (e.dying && this.tick >= e.dying) { this.remove(e); continue; }
      if (e.age % 2) continue;
      let [x, y] = this.next(e, e.direction);
      if (!this.inBounds(x, y) || this.at(x, y)?.kind === 'wall') {
        x = e.x; y = e.y;
        for (let i = 0; i < Math.max(this.level.width, this.level.height); i++) {
          const [bx, by] = this.next({ x, y }, inverse(e.direction));
          if (!this.inBounds(bx, by) || this.at(bx, by)?.kind === 'wall') break;
          x = bx; y = by;
        }
      }
      const target = this.at(x, y);
      if (target && target.kind !== 'river' && !riverTargets.has(target.kind)) continue;
      moves.push({ e, x, y });
    }
    // Decide all destinations against one snapshot; never overwrite a segment that is staying still.
    const accepted = new Map<number, { e: Entity; x: number; y: number }>();
    const destinations = new Set<string>();
    for (const m of moves) {
      const key = `${m.x},${m.y}`;
      if (!destinations.has(key)) { destinations.add(key); accepted.set(m.e.id, m); }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, m] of accepted) {
        const target = this.at(m.x, m.y);
        if (target?.kind === 'river' && target !== m.e && !accepted.has(target.id)) { accepted.delete(id); changed = true; }
      }
    }
    for (const m of accepted.values()) if (this.at(m.e.x, m.e.y) === m.e) this.grid[m.e.y * this.level.width + m.e.x] = undefined;
    for (const m of accepted.values()) {
      const target = this.at(m.x, m.y);
      if (target) {
        this.damage(target, 'river');
        const residue = this.at(m.x, m.y);
        if (residue) this.remove(residue);
      }
      m.e.x = m.x; m.e.y = m.y; this.grid[m.y * this.level.width + m.x] = m.e;
    }
  }

  /** Detached simulation checkpoint; pending input and already-delivered audio are excluded. */
  snapshot(): WorldState {
    return { tick: this.tick, remaining: this.remaining, collected: this.collected,
      keys: this.keys, ammo: this.ammo, status: this.status, statusTicks: this.statusTicks,
      teleportTicks: this.teleportTicks, magnetOwner: this.magnetOwner,
      deathPresentationPending: this.deathPresentationPending, nextId: this.nextId,
      robot: { ...this.robot }, entities: [...this.entities.values()].map(e => ({ ...e })),
      blasts: this.blasts.map(b => ({ ...b })),
      lasers: this.lasers.map(l => ({ ...l, owner: { ...l.owner }, parts: l.parts.map(part => ({ ...part })) })) };
  }

  restore(raw: unknown): void {
    const data = readWorldState(raw, this.level);
    this.grid.fill(undefined); this.entities.clear();
    for (const e of data.entities) { this.entities.set(e.id, e); this.grid[e.y * this.level.width + e.x] = e; }
    this.robot = this.entities.get(data.robot.id) ?? data.robot;
    this.tick = data.tick; this.remaining = data.remaining; this.collected = data.collected;
    this.keys = data.keys; this.ammo = data.ammo; this.status = data.status; this.statusTicks = data.statusTicks;
    this.teleportTicks = data.teleportTicks; this.magnetOwner = data.magnetOwner;
    this.deathPresentationPending = data.deathPresentationPending; this.nextId = data.nextId;
    this.blasts.splice(0, this.blasts.length, ...data.blasts);
    this.lasers.splice(0, this.lasers.length, ...data.lasers.map(l => ({ ...l, direction: l.direction as Direction,
      owner: this.entities.get(l.owner.id) ?? l.owner,
      parts: l.parts.map(part => this.entities.get(part.id) ?? part) })));
    this.events.length = 0; this.clearInput(); this.assertConsistent();
  }

  /** Used by data validation and deterministic tests, never by rendering. */
  assertConsistent(): void {
    const ids = new Set<number>();
    for (const e of this.entities.values()) {
      if (!e.alive || !this.inBounds(e.x, e.y) || this.at(e.x, e.y) !== e || ids.has(e.id)) throw Error(`Invalid occupancy for ${e.kind} ${e.id}`);
      ids.add(e.id);
    }
    for (const cell of this.grid) if (cell && !this.entities.has(cell.id)) throw Error('Orphaned grid entity');
  }
}
