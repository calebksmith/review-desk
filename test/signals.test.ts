import { describe, expect, it } from 'vitest';
import type { PrSummary } from '../src/protocol';
import { SampleSource } from '../src/sample';
import { parseDependsOn, parseLinear, reasons, signals, tier } from '../src/signals';
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
