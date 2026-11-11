import { describe, expect, it } from 'vitest';
import { duration, statusCard } from '../src/card';
import { SampleSource } from '../src/sample';

const team = async (n: number, repo = 'acme/storefront') => {
  const s = new SampleSource('team');
  return { pr: await s.getPr(repo, n, null), queue: await s.listPrs() };
};

describe('status card', () => {
  it('splits Codex findings from plain comments, and needs an approval on a team', async () => {
    const { pr, queue } = await team(102);
    const card = statusCard(pr, queue, 'calebksmith');
    const part = (k: string) => card.parts.find((p) => p.key === k)!;
    expect(part('findings')).toMatchObject({ summary: '1 P1 open +1', tone: 'warn', segments: ['warn', 'muted'] });
    expect(part('comments')).toMatchObject({ summary: 'None' });
    expect(part('approvals')).toMatchObject({ summary: 'Needed', locked: true });
    expect(part('checks')).toMatchObject({ summary: 'All 4 passed', locked: true, segments: ['ok', 'ok', 'ok', 'ok'] });
    expect(card.blockers.map((b) => b.key)).toEqual(['stack']);
    expect(card.sub).toBe('Your review is next.');
  });

  it('marks a failing required check as blocking, and names the conflict as a blocker', async () => {
    const { pr, queue } = await team(112);
    expect(statusCard(pr, queue, 'calebksmith').parts[0]).toMatchObject({ summary: '1 failing', tone: 'bad', segments: ['ok', 'ok', 'bad', 'ok'] });
    const node22 = await team(121);
    expect(statusCard(node22.pr, node22.queue, 'calebksmith').blockers.map((b) => b.key)).toEqual(['conflicts']);
  });

  it('calls optional failures optional', async () => {
    const s = new SampleSource();
    const pr = await s.getPr('calebksmith/portfolio', 61, null);
    expect(statusCard(pr, await s.listPrs(), 'calebksmith').parts[0]).toMatchObject({ summary: '2 failing, optional', tone: 'warn', locked: false });
    expect(pr.compatibility).toBe(17);
  });

  it('counts unsent comments under Comments without holding up a merge', async () => {
    const s = new SampleSource();
    const queue = await s.listPrs();
    const ready = { ...(await s.getPr('calebksmith/portfolio', 60, null)), myReview: 'approved' as const };
    const card = statusCard(ready, queue, 'calebksmith', 3);
    expect(card).toMatchObject({ ready: true, title: 'Ready to merge' });
    expect(card.parts[2]).toMatchObject({ summary: '3 unsent', tone: 'muted' });
    // Resolved threads keep their state, with the unsent count beside it.
    const resolved = await s.getPr('calebksmith/portfolio', 55, null);
    expect(statusCard(resolved, queue, 'calebksmith', 1).parts[2]).toMatchObject({ summary: 'All resolved · 1 unsent', tone: 'ok' });
  });

  it('shrinks to one line when everything’s fine', async () => {
    const s = new SampleSource();
    const queue = await s.listPrs();
    const pr = { ...(await s.getPr('calebksmith/portfolio', 60, null)), myReview: 'approved' as const };
    const card = statusCard(pr, queue, 'calebksmith');
    expect(card).toMatchObject({ ready: true, title: 'Ready to merge' });
    expect(card.sub).toBe('checks: all 3 passed · approvals: approved by you');
  });

  it('says whose turn it is on your own PR', async () => {
    const { pr, queue } = await team(122);
    expect(statusCard(pr, queue, 'calebksmith').sub).toBe('Waiting on priya to review.');
  });

  it('formats how long a check ran', () => {
    expect([duration(38), duration(217), duration(3900), duration(null)]).toEqual(['38s', '4m', '1h 5m', '']);
  });
});
