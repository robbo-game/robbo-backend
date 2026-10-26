import { symbolKinds } from './model';
import type { Kind } from './model';

export type MapFormat = 'java' | 'gnu' | 'prototype';
export interface SymbolMeaning { kind?: Kind; unsupported?: string; canonical: string }
/** Formats must be selected explicitly: identical glyphs can have different meanings. */
export function symbolMeaning(symbol: string, format: MapFormat): SymbolMeaning | undefined {
  if (symbol === '.') return { canonical: '.' };
  if (format === 'gnu' && symbol === '+') return { canonical: '.', unsupported: 'GNU life pickups are unsupported; explicit conversion approval is required' };
  if (format === 'gnu' && symbol === 'k') return { canonical: 'k', unsupported: 'GNU barbed wire has no verified compatible artwork or selected campaign' };
  if (format === 'prototype' && symbol === 'x') return { canonical: 'T', kind: 'screw' };
  if (format === 'prototype' && 'IJYZijyz'.includes(symbol)) return { canonical: symbol, unsupported: 'Prototype wall alias has no verified current atlas mapping' };
  const kind = symbolKinds[symbol];
  return kind ? { canonical: symbol, kind } : undefined;
}
export function auditSymbols(rows: readonly string[], format: MapFormat, pack: string, planet: number): string[] {
  const problems: string[] = [];
  rows.forEach((row, y) => Array.from(row).forEach((symbol, x) => {
    const meaning = symbolMeaning(symbol, format);
    if (!meaning || meaning.unsupported) problems.push(`${pack}, planet ${planet}, (${x},${y}), symbol ${JSON.stringify(symbol)}: ${meaning?.unsupported ?? 'unknown symbol'}`);
  }));
  return problems;
}
export function requireSupportedSymbols(rows: readonly string[], format: MapFormat, pack: string, planet: number): void {
  const errors = auditSymbols(rows, format, pack, planet);
  if (errors.length) throw Error(errors.join('\n'));
}
