import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../src/protocol';
import { SampleSource } from '../src/sample';
import { inMilestone, milestones, NO_MILESTONE, parseDependsOn, parseLinear, reasons, signals, tier } from '../src/signals';
import { priority, priorityOrder } from '../src/status';

describe('parsing', () => {
  it('reads what a description says it waits on', () => {
    expect(parseDependsOn('Depends on #12 and #13. Blocked by #20, #21. After #5. Fixes #9.')).toEqual([12, 13, 20, 21, 5]);
    expect(parseDependsOn('Nothing here, see #4')).toEqual([]);
  });

  it('finds the Linear issue from a link, a branch or a title', () => {
    expect(parseLinear({ title: 'x', headRef: 'a', body: 'See https://linear.app/acme/issue/ENG-398/upgrade-node' })).toEqual({ key: 'ENG-398', url: 'https://linear.app/acme/issue/ENG-398/upgrade-node' });
    expect(parseLinear({ title: 'x', headRef: 'sam/eng-412-search-index', body: '' })).toEqual({ key: 'ENG-412', url: null });
    expect(parseLinear({ title: '[ENG-7] Fix it', headRef: 'fix', body: '' })).toEqual({ key: 'ENG-7', url: null });
    expect(parseLinear({ title: 'Support UTF-8 names', headRef: 'utf8-names', body: 'P1-orange badge' })).toBeNull();
  });
});

describe('signals and priority', () => {
  const now = Date.now();
  it('counts what waits on a PR: its stack, and PRs that depend on it', async () => {
    const q = await new SampleSource('team').listPrs();
    const get = (repo: string, n: number) => q.find((p) => p.repo === repo && p.number === n)!;
    expect(signals(get('acme/storefront', 101), q, []).blocks).toBe(3);
    expect(signals(get('acme/storefront', 110), q, []).blocks).toBe(2);
    const node22 = signals(get('acme/storefront', 121), q, ['release-blocker']);
    expect(node22).toMatchObject({ blocks: 1, release: { title: 'Nov 14 release', soon: true } });
    expect(tier(node22)).toBe(0);
    expect(signals(get('acme/storefront', 126), q, ['hotfix']).releaseBlocker).toBe(true);
    // The same number in another repo isn't the same PR.
    expect(signals(get('acme/payments-api', 102), q, []).blocks).toBe(0);
  });

  it('puts release blockers and releases due soon first, then what others wait on, oldest wait first', async () => {
    const q = await new SampleSource('team').listPrs();
    const yours = q.filter((p) => priority(p).section === 'you').sort(priorityOrder({ queue: q, blockerLabels: ['hotfix'] }));
    const order = yours.map((p) => `${p.repo.split('/')[1]}#${p.number}`);
    expect(order.slice(0, 2).sort()).toEqual(['storefront#121', 'storefront#126']);
    expect(order.indexOf('storefront#102')).toBeLessThan(order.indexOf('storefront#125'));
    expect(order.indexOf('storefront#112')).toBeLessThan(order.indexOf('payments-api#102'));
  });

  it('gives short reasons, most important first', () => {
    const p = { findingCounts: { p0: 0, p1: 2 } } as PrSummary;
    const r = reasons(p, { blocks: 3, releaseBlocker: true, release: null, waitingSince: new Date(now - 3 * 86_400_000).toISOString() }, now);
    expect(r.map((x) => x.text)).toEqual(['Release blocker', 'Blocks 3', '2 P1 open']);
    const waiting = reasons({ findingCounts: { p0: 0, p1: 0 } } as PrSummary, { blocks: 0, releaseBlocker: false, release: null, waitingSince: new Date(now - 2 * 86_400_000).toISOString() }, now);
    expect(waiting.map((x) => x.text)).toEqual(['Waiting 2d']);
  });
});

describe('milestones', () => {
  const ms = (title: string, dueOn: string | null) => ({ milestone: { title, dueOn } }) as PrSummary;
  const none = { milestone: null } as PrSummary;
  const queue = [ms('Dec release', '2026-12-05T00:00:00Z'), ms('Someday', null), ms('Nov release', '2026-11-14T00:00:00Z'), ms('Nov release', '2026-11-14T00:00:00Z'), none];

  it('lists each milestone once for the filter, soonest due first and undated last, with how many PRs it holds', () => {
    expect(milestones(queue).map((m) => [m.title, m.count])).toEqual([['Nov release', 2], ['Dec release', 1], ['Someday', 1]]);
    expect(milestones([none])).toEqual([]);
  });

  it('filters to one milestone, to PRs without one, or not at all', () => {
    expect(queue.filter((p) => inMilestone(p, 'Nov release'))).toHaveLength(2);
    expect(queue.filter((p) => inMilestone(p, NO_MILESTONE))).toEqual([none]);
    expect(queue.filter((p) => inMilestone(p, null))).toHaveLength(5);
  });

  it('says only when a milestone is due, since the row already names it; a release branch keeps its name', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    const release = { title: 'Nov release', dueOn: '2026-11-14T00:00:00Z', soon: true };
    const base = { findingCounts: { p0: 0, p1: 0 } } as PrSummary;
    const s = { blocks: 0, releaseBlocker: false, release, waitingSince: new Date(now).toISOString() };
    expect(reasons({ ...base, milestone: { title: 'Nov release', dueOn: release.dueOn } }, s, now)[0]).toMatchObject({ text: 'Due tomorrow', tone: 'warn', title: 'Nov release' });
    expect(reasons({ ...base, milestone: null }, { ...s, release: { title: 'release/2.4', dueOn: null, soon: false } }, now)[0]?.text).toBe('release/2.4');
  });
});
