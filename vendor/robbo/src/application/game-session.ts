import type { Direction, Pack, SeededRandom } from '../engine/model';
import { seededRandom } from '../engine/model';
import { GameWorld } from '../engine/game-world';

export class GameSession {
  static readonly deathRestartTicks = 12;
  world!: GameWorld;
  completed = false;
  paused = false;
  started = false;
  generation = 0;
  private planetIndex = 0;
  private random!: SeededRandom;
  get randomState(): number { return this.random.state; }
  restoreRandomState(state: number): void { this.random.state = state >>> 0; }
  constructor(public pack: Pack, private seed = Date.now()) { this.load(0); }
  get initialSeed(): number { return this.seed >>> 0; }
  get planet(): number { return this.planetIndex + 1; }
  private load(index: number): void {
    this.planetIndex = index; this.completed = false; this.generation++;
    this.random = seededRandom(this.seed + index);
    this.world = new GameWorld(this.pack.levels[index], this.random);
    this.world.emit('capsule');
  }
  start(): void { this.started = true; this.paused = false; this.world.clearInput(); }
  restart(): void { this.load(this.planetIndex); this.start(); }
  /** Retry uses the same visible death sequence as a lost attempt. */
  retry(): void { this.world.beginDeathPresentation(); }
  newCampaign(pack = this.pack): void { this.pack = pack; this.load(0); this.start(); }
  selectPlanet(number: number): void {
    if (!Number.isInteger(number) || number < 1 || number > this.pack.levels.length) throw Error('Invalid planet');
    this.load(number - 1); this.start();
  }
  togglePause(): void { if (this.started && !this.completed) { this.paused = !this.paused; this.world.clearInput(); } }
  command(direction: Direction, fire = false, aimOnly = false): void { if (this.started && !this.paused && !this.completed) this.world.command(direction, fire, aimOnly); }
  step(): void {
    if (!this.started || this.paused || this.completed) return;
    this.world.step();
    if (this.world.status === 'dead' && this.world.statusTicks >= GameSession.deathRestartTicks) {
      this.restart(); return;
    }
    if (this.world.status === 'won' && this.world.statusTicks >= 5) {
      if (this.planetIndex + 1 === this.pack.levels.length) this.completed = true;
      else this.load(this.planetIndex + 1);
    }
  }
}
