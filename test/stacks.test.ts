import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../src/protocol';
import { childrenOf, mergeTree, parentOf, stackOf, stacks } from '../src/stacks';

const pr = (number: number, headRef: string, baseRef = 'main', state: PrSummary['state'] = 'open') => ({ repo: 'acme/web', number, headRef, baseRef, state }) as PrSummary;
// main ← 1 ← 2 ← 3, and 2 also has 4; 5 stands alone; 6 is merged and stacked on 5's branch.
const queue = [pr(3, 'c', 'b'), pr(1, 'a'), pr(2, 'b', 'a'), pr(4, 'd', 'b'), pr(5, 'e'), pr(6, 'f', 'e', 'merged')];

describe('stacks', () => {
  it('finds a PR’s parent and children by branch', () => {
    expect(parentOf(queue[0]!, queue)?.number).toBe(2);
    expect(parentOf(queue[1]!, queue)).toBeNull();
    expect(childrenOf(queue[2]!, queue).map((p) => p.number)).toEqual([3, 4]);
  });

  it('walks the whole stack from its bottom, in merge order, with depths', () => {
    expect(stackOf(queue[0]!, queue).map((r) => [r.pr.number, r.depth])).toEqual([[1, 0], [2, 1], [3, 2], [4, 2]]);
    expect(stackOf(queue[4]!, queue).map((r) => r.pr.number)).toEqual([5]);
  });

  it('splits open PRs into stacks and PRs that stand alone, ignoring merged ones', () => {
    const s = stacks(queue);
    expect(s.stacks.map((st) => st.map((r) => r.pr.number))).toEqual([[1, 2, 3, 4]]);
    expect(s.alone.map((p) => p.number)).toEqual([5]);
  });

  it('survives a loop of branches', () => {
    const loop = [pr(1, 'a', 'b'), pr(2, 'b', 'a')];
    expect(stackOf(loop[0]!, loop).length).toBeLessThanOrEqual(2);
  });
});

describe('mergeTree', () => {
  it('draws a chain as one column, newest on top, the bottom PR last', () => {
    const chain = [pr(1, 'a'), pr(2, 'b', 'a'), pr(3, 'c', 'b')];
    const t = mergeTree(stackOf(chain[0]!, chain), chain);
    expect(t.lanes).toBe(1);
    expect(t.rows.map((r) => [r.pr.number, r.lane, r.up])).toEqual([[3, 0, false], [2, 0, true], [1, 0, true]]);
  });

  it('gives a fork’s second branch its own column, passing by the first and curving into the base', () => {
    const fork = [pr(10, 'base'), pr(11, 'x', 'base'), pr(12, 'y', 'base')];
    const t = mergeTree(stackOf(fork[0]!, fork), fork);
    expect(t.lanes).toBe(2);
    expect(t.rows.map((r) => r.pr.number)).toEqual([12, 11, 10]);
    expect(t.rows[1]).toMatchObject({ lane: 0, through: [1] });
    expect(t.rows[2]).toMatchObject({ lane: 0, up: true, joins: [1] });
  });
});
