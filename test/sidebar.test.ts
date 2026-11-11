import { describe, expect, it } from 'vitest';
import { SampleSource } from '../src/sample';
import { needsYou, queueGroups, repoGroups } from '../src/sidebar';

describe('sidebar', () => {
  it('groups PRs in working order, open P1s then failing checks first, and leaves out empty groups', async () => {
    const queue = await new SampleSource().listPrs();
    const groups = queueGroups(queue);
    expect(groups.map((g) => g.label)).toEqual(['Needs you', 'Merged']);
    const needs = groups[0]!.prs.map((p) => p.number);
    expect(needs.slice(0, 2).sort()).toEqual([58, 59]);
    expect(needs.slice(2, 4).sort()).toEqual([55, 61]);
    expect(needs).toHaveLength(7);
  });

  it('counts what needs the reviewer for the badge', async () => {
    const queue = await new SampleSource().listPrs();
    expect(needsYou(queue)).toBe(7);
    // Approving everything leaves the two failing PRs, plus four ready to merge, which alone is your move: 6.
    expect(needsYou(queue.map((p) => ({ ...p, myReview: 'approved' as const })))).toBe(6);
  });
});

describe('sidebar with a team', () => {
  it('groups your PRs apart and counts what needs you', async () => {
    const queue = await new SampleSource('team').listPrs();
    expect(queueGroups(queue).map((g) => g.label)).toEqual(['Needs you', 'Your PRs', 'Waiting on others', 'Approved', 'Merged']);
    expect(queueGroups(queue).find((g) => g.bucket === 'mine')!.prs.map((p) => `${p.repo}#${p.number}`).sort()).toEqual([
      'acme/payments-api#108', 'acme/payments-api#109', 'acme/storefront#122', 'acme/storefront#123', 'acme/storefront#124',
    ]);
    // Review requests and unassigned PRs (storefront 102, 103, 112, 121, 125, 126, 127; payments 102), the re-review
    // of 110 (priya pushed after your changes request), plus your 123 (ready) and 124 (changes requested).
    expect(needsYou(queue)).toBe(11);
    // Both repos have a #102; they're two PRs.
    expect(queue.filter((p) => p.number === 102).map((p) => p.repo).sort()).toEqual(['acme/payments-api', 'acme/storefront']);
  });
});

describe('sidebar across repos', () => {
  it('groups by repo, most of your turn first, each with its own status groups', async () => {
    const queue = await new SampleSource('team').listPrs();
    const repos = repoGroups(queue);
    expect(repos.map((r) => [r.repo, r.yourTurn])).toEqual([['acme/storefront', 10], ['acme/payments-api', 1]]);
    expect(repos[1]!.groups.map((g) => g.label)).toEqual(['Needs you', 'Your PRs']);
    expect(repos[1]!.groups.flatMap((g) => g.prs).every((p) => p.repo === 'acme/payments-api')).toBe(true);
    expect(repoGroups([])).toEqual([]);
  });
});
