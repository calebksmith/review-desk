import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../src/protocol';
import { combine, scopeLabel, searchQueries } from '../src/scope';

describe('scope', () => {
  it('names what the queue covers', () => {
    expect(scopeLabel({ kind: 'repo', repo: 'acme/web' })).toBe('acme/web');
    expect(scopeLabel({ kind: 'involves', full: [] })).toBe('Everything involving you');
    expect(scopeLabel({ kind: 'involves', full: ['acme/web'] })).toBe('Everything involving you + acme/web');
    expect(scopeLabel({ kind: 'involves', full: ['acme/web', 'acme/api'] })).toBe('Everything involving you + 2 repos');
  });

  it('searches for review requests and reviews as well as involves:, which misses them', () => {
    const q = searchQueries(new Date('2026-11-03T12:00:00Z'));
    expect(q.open).toEqual([
      'is:pr archived:false is:open involves:@me',
      'is:pr archived:false is:open review-requested:@me',
      'is:pr archived:false is:open reviewed-by:@me',
    ]);
    expect(q.merged).toBe('is:pr archived:false is:merged involves:@me merged:>=2026-11-03');
  });

  it('keeps each PR once across lists, telling repos apart, newest first', () => {
    const pr = (repo: string, number: number, at: string) => ({ repo, number, updatedAt: at }) as PrSummary;
    const out = combine([[pr('a/x', 1, '2026-01-01'), pr('a/y', 1, '2026-01-03')], [pr('a/x', 1, '2026-01-02')]]);
    expect(out.map((p) => [p.repo, p.number, p.updatedAt])).toEqual([['a/y', 1, '2026-01-03'], ['a/x', 1, '2026-01-02']]);
  });
});
