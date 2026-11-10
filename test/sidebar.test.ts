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
    // Approving everything leaves the two failing PRs, plus two ready to merge, which alone is your move: 4.
    expect(needsYou(queue.map((p) => ({ ...p, myReview: 'approved' as const })))).toBe(4);
  });
});

describe('sidebar with a team', () => {
  it('groups your PRs apart and counts what needs you', async () => {
    const queue = await new SampleSource('team').listPrs();
    expect(queueGroups(queue).map((g) => g.label)).toEqual(['Needs you', 'Your PRs', 'Waiting on others', 'Approved', 'Merged']);
    expect(queueGroups(queue).find((g) => g.bucket === 'mine')!.prs.map((p) => `${p.repo}#${p.number}`).sort()).toEqual([
      'acme/payments-api#108', 'acme/payments-api#109', 'acme/storefront#122', 'acme/storefront#123', 'acme/storefront#124',
    ]);
    // Review requests and unassigned PRs (storefront 102, 103, 112, 121, 125, 126, 127; payments 102) plus your 123 (ready) and 124 (changes requested).
    expect(needsYou(queue)).toBe(10);
    // Both repos have a #102; they're two PRs.
    expect(queue.filter((p) => p.number === 102).map((p) => p.repo).sort()).toEqual(['acme/payments-api', 'acme/storefront']);
  });
});
