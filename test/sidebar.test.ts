import { describe, expect, it } from 'vitest';
import { SampleSource } from '../src/sample';
import { needsYou, queueGroups } from '../src/sidebar';

describe('sidebar', () => {
  it('groups PRs in working order, failing first, and leaves out empty groups', async () => {
    const queue = await new SampleSource().listPrs();
    const groups = queueGroups(queue);
    expect(groups.map((g) => g.label)).toEqual(['Needs you', 'Merged']);
    const needs = groups[0]!.prs.map((p) => p.number);
    expect(needs.slice(0, 2).sort()).toEqual([55, 61]);
    expect(needs).toHaveLength(5);
  });

  it('counts what needs the reviewer for the badge', async () => {
    const queue = await new SampleSource().listPrs();
    expect(needsYou(queue)).toBe(5);
    expect(needsYou(queue.map((p) => ({ ...p, myReview: 'approved' as const })))).toBe(2);
  });
});
