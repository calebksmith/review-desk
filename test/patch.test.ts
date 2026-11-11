import { describe, expect, it } from 'vitest';
import { inDiff, parsePatch } from '../src/patch';
import { parseRemote } from '../src/remote';

describe('parsePatch', () => {
  it('numbers added, removed and context lines', () => {
    const lines = parsePatch(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n'));
    expect(lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'b' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'B' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
    ]);
  });

  it('marks the lines skipped before and between hunks', () => {
    const lines = parsePatch(['@@ -10,2 +10,2 @@', ' x', '-y', '+Y', '@@ -20,1 +20,1 @@', ' z'].join('\n'));
    expect(lines[0]).toEqual({ kind: 'gap', hidden: 9 });
    const gaps = lines.filter((l) => l.kind === 'gap');
    expect(gaps).toEqual([{ kind: 'gap', hidden: 9 }, { kind: 'gap', hidden: 8 }]);
  });

  it('ignores "no newline at end of file" markers', () => {
    const lines = parsePatch(['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n'));
    expect(lines.map((l) => l.kind)).toEqual(['del', 'add']);
  });

  it('starts a new file without a gap', () => {
    expect(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b')[0]).toEqual({ kind: 'add', oldNo: null, newNo: 1, text: 'a' });
  });
});

describe('inDiff', () => {
  it('finds removed lines on the left, added and unchanged ones on the right, and nothing outside the hunks', () => {
    const lines = parsePatch(['@@ -10,3 +10,3 @@', ' a', '-b', '+B', ' c'].join('\n'));
    expect(inDiff(lines, 'RIGHT', 11)).toBe(true);
    expect(inDiff(lines, 'RIGHT', 10)).toBe(true);
    expect(inDiff(lines, 'LEFT', 11)).toBe(true);
    expect(inDiff(lines, 'LEFT', 10)).toBe(false);
    expect(inDiff(lines, 'RIGHT', 3)).toBe(false);
    expect(inDiff(lines, 'RIGHT', null)).toBe(false);
  });
});

describe('parseRemote', () => {
  it.each([
    ['https://github.com/calebksmith/portfolio.git', 'calebksmith/portfolio'],
    ['git@github.com:calebksmith/review-desk.git', 'calebksmith/review-desk'],
    ['https://github.com/calebksmith/portfolio', 'calebksmith/portfolio'],
    ['https://gitlab.com/a/b.git', null],
  ])('%s', (url, repo) => expect(parseRemote(url)).toBe(repo));
});
