import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './search.js';

describe('reciprocal rank fusion', () => {
  it('ranks a result found by both retrievers above one found by either alone', () => {
    const fused = reciprocalRankFusion([
      { source: 'lexical', ids: ['a', 'b', 'c'] },
      { source: 'semantic', ids: ['c', 'd', 'a'] },
    ]);
    const ordered = [...fused.entries()].sort((x, y) => y[1].score - x[1].score).map(([id]) => id);
    expect(ordered[0]).toBe('a');
    expect(fused.get('a')?.sources).toEqual(['lexical', 'semantic']);
    expect(fused.get('d')?.sources).toEqual(['semantic']);
  });

  it('keeps working when one retriever returns nothing', () => {
    const fused = reciprocalRankFusion([
      { source: 'lexical', ids: ['x', 'y'] },
      { source: 'semantic', ids: [] },
    ]);
    expect([...fused.keys()]).toEqual(['x', 'y']);
    expect(fused.get('x')!.score).toBeGreaterThan(fused.get('y')!.score);
  });

  it('returns an empty map for no input', () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});
