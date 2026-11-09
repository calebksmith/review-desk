import { describe, expect, it } from 'vitest';
import { toMergeState, mergeMethods } from '../src/github';
import type { PrDetail, PrSummary } from '../src/protocol';
import { bulkMergeable, bulkSkipReason, mergeBlocker, mergeReadiness, mergeWarning, prStatus } from '../src/status';

const base: PrSummary = {
  number: 1, title: 't', author: 'a', url: '', additions: 0, deletions: 0, updatedAt: '', headSha: 'abc', isDraft: false, state: 'open',
  labels: [], myReview: null, checks: { passed: 3, failed: 0, pending: 0, total: 3 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 0,
};
const pr = (p: Partial<PrSummary> = {}): PrSummary => ({ ...base, ...p });
const detail = (p: Partial<PrDetail> = {}): PrDetail => ({ ...base, nodeId: '', body: '', bodyHtml: '', conversation: [], headRef: 'h', baseRef: 'main', mergeMethods: ['squash'], files: [], checkRuns: [], sinceLastLook: null, ...p });

describe('prStatus', () => {
  it('names each state once', () => {
    expect(prStatus(pr()).label).toBe('Needs your review');
    expect(prStatus(pr({ state: 'merged' })).label).toBe('Merged');
    expect(prStatus(pr({ isDraft: true })).who).toBe('author');
    expect(prStatus(pr({ myReview: 'approved' })).label).toBe('Ready to merge');
    expect(prStatus(pr({ myReview: 'changes_requested' })).bucket).toBe('waiting');
  });

  it('uses red only for what blocks merge', () => {
    expect(prStatus(pr({ mergeable: false }))).toMatchObject({ label: 'Has conflicts', tone: 'bad' });
    expect(prStatus(pr({ checks: { passed: 1, failed: 2, pending: 0, total: 3 } }))).toMatchObject({ label: '2 checks failing', tone: 'bad' });
    expect(prStatus(pr({ myReview: 'approved', mergeState: 'behind' })).tone).toBe('warn');
    expect(prStatus(pr({ myReview: 'approved', checks: { passed: 1, failed: 0, pending: 2, total: 3 } })).tone).toBe('run');
  });

  it('puts conflicts ahead of failing checks', () => {
    expect(prStatus(pr({ mergeable: false, checks: { passed: 0, failed: 1, pending: 0, total: 1 } })).label).toBe('Has conflicts');
  });
});

describe('mergeReadiness', () => {
  it('lists conflicts, base, checks and open threads', () => {
    const items = mergeReadiness(detail({ mergeState: 'behind', unresolvedThreads: 2, checks: { passed: 2, failed: 1, pending: 0, total: 3 } }));
    expect(items.map((i) => [i.key, i.tone])).toEqual([['conflicts', 'ok'], ['base', 'warn'], ['checks', 'bad'], ['threads', 'warn']]);
    expect(items.find((i) => i.key === 'base')?.action).toBe('updateBranch');
  });

  it('says when conflicts are still being worked out', () => {
    expect(mergeReadiness(detail({ mergeable: null }))[0]).toMatchObject({ tone: 'muted', text: 'Checking for conflicts' });
  });

  it('blocks merge only on red items', () => {
    expect(mergeBlocker(detail())).toBe(null);
    expect(mergeBlocker(detail({ mergeState: 'behind' }))).toBe(null);
    expect(mergeBlocker(detail({ mergeable: false }))).toMatch(/conflicts/);
    expect(mergeBlocker(detail({ checks: { passed: 0, failed: 1, pending: 0, total: 1 } }))).toBe(null);
  });

  it('warns about failing checks by name, without blocking', () => {
    const failing = { passed: 1, failed: 2, pending: 0, total: 3 };
    const run = (name: string, conclusion: 'success' | 'failure') => ({ name, app: '', status: 'completed' as const, conclusion, url: null, summary: null, failedStep: null, excerpt: null });
    expect(mergeWarning(detail())).toBe(null);
    expect(mergeWarning(detail({ checks: failing, checkRuns: [run('checks', 'failure'), run('lint', 'success'), run('Vercel', 'failure')] }))).toBe('checks, Vercel are failing');
    expect(mergeWarning(detail({ checks: { ...failing, failed: 1 }, checkRuns: [run('checks', 'failure')] }))).toBe('checks is failing');
    expect(mergeWarning(detail({ checks: failing }))).toBe('2 checks failing');
  });
});

describe('GitHub mapping', () => {
  it('maps merge states', () => {
    expect(toMergeState('BEHIND')).toBe('behind');
    expect(toMergeState('HAS_HOOKS')).toBe('unknown');
  });
  it('lists allowed merge methods, squash first', () => {
    expect(mergeMethods({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true })).toEqual(['squash', 'rebase']);
    expect(mergeMethods({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false })).toEqual(['merge']);
  });
});

describe('bulk merge', () => {
  const dep = (p: Partial<PrSummary> = {}) => pr({ author: 'dependabot', ...p });
  it('takes Dependabot PRs with no conflicts and passing checks, oldest first', () => {
    const queue = [dep({ number: 9 }), pr({ number: 3 }), dep({ number: 4, author: 'dependabot[bot]' })];
    expect(bulkMergeable(queue).map((p) => p.number)).toEqual([4, 9]);
  });

  it('leaves out the rest, saying why', () => {
    expect(bulkSkipReason(dep({ mergeable: false }))).toBe('conflicts with its base');
    expect(bulkSkipReason(dep({ mergeable: null }))).toBe('GitHub still checking for conflicts');
    expect(bulkSkipReason(dep({ checks: { passed: 1, failed: 1, pending: 0, total: 2 } }))).toBe('1 check failing');
    expect(bulkSkipReason(dep({ checks: { passed: 1, failed: 0, pending: 1, total: 2 } }))).toBe('checks still running');
    expect(bulkSkipReason(dep({ isDraft: true }))).toBe('draft');
    expect(bulkSkipReason(dep({ state: 'merged' }))).toBe('already merged');
    expect(bulkSkipReason(dep({ mergeState: 'behind' }))).toBeNull();
    expect(bulkMergeable([dep({ mergeable: false })])).toEqual([]);
  });
});
