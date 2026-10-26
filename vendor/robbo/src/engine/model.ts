/** Legacy direction numbers are intentionally kept at the data boundary. */
export type Direction = 0 | 1 | 2 | 3;
export const vectors = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
export const inverse = (d: Direction): Direction => ((d + 2) % 4) as Direction;
export interface LevelData {
  number: number;
  width: number;
  height: number;
  colour: string;
  author: string;
  notes: string;
  offset: string;
  rows: string[];
  options: Record<string, number[]>;
}
export interface Pack { id: string; name: string; lastLevel: number; levels: LevelData[] }
export type Kind = 'robot' | 'wall' | 'ship' | 'screw' | 'key' | 'ammo' | 'door' | 'box' | 'momentum' | 'bomb' | 'question' | 'mirror' | 'magnet' | 'river' | 'bird' | 'bear' | 'worm' | 'eyes' | 'cannon' | 'sand' | 'stop' | 'shot' | 'flame' | 'beam' | 'smoke' | 'impact' | 'blast';
export interface Entity {
  id: number; kind: Kind; symbol: string; x: number; y: number; direction: Direction;
  age: number; frame: number; alive: boolean;
  fireDirection: Direction; shooting: boolean; fireType: number; moving: boolean; rotating: boolean;
  countdown: number; rotationInterval: number; hand?: number; observer?: Direction;
  group: number; index: number; motion: boolean; expires: number; after?: Kind; dying: number;
  owner?: number; spawned: boolean;
}
export type SoundName = 'exit-open' | 'walk' | 'shoot' | 'gun' | 'ammo' | 'screw' | 'key' | 'door' | 'box' | 'bomb' | 'kill' | 'teleport' | 'end' | 'capsule' | 'magnet' | 'bird' | 'worm';
export interface GameEvent { type: SoundName; tick: number }
/** aimOnly changes orientation without movement or firing; omission preserves legacy commands. */
export interface Command { direction: Direction; fire: boolean; aimOnly?: boolean }
export const symbolKinds: Record<string, Kind> = {
  R: 'robot', '!': 'ship', T: 'screw', '%': 'key', "'": 'ammo', D: 'door', '#': 'box', '~': 'momentum', b: 'bomb', '?': 'question', '&': 'mirror', M: 'magnet', '=': 'river', '^': 'bird', '@': 'bear', '*': 'worm', V: 'eyes', '}': 'cannon', H: 'sand', X: 'stop',
  s: 'wall', '-': 'wall', O: 'wall', o: 'wall', S: 'wall', p: 'wall', P: 'wall', Q: 'wall', q: 'wall', '+': 'wall'
};
export const kindSymbols: Partial<Record<Kind, string>> = Object.fromEntries(Object.entries(symbolKinds).map(([s, k]) => [k, s]));
export interface SeededRandom { (): number; state: number }
export function seededRandom(seed: number): SeededRandom {
  const random: SeededRandom = () => {
    random.state = (Math.imul(random.state, 1664525) + 1013904223) >>> 0;
    return random.state / 4294967296;
  };
  random.state = seed >>> 0;
  return random;
}
