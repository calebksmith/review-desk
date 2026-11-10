import { describe, expect, it } from 'vitest';
import { toMergeState, mergeMethods } from '../src/github';
import type { PrDetail, PrSummary } from '../src/protocol';
import { bulkMergeable, bulkSkipReason, mergeBlocker, mergeReadiness, mergeSummary, mergeWarning, prStatus } from '../src/status';

const base: PrSummary = {
  number: 1, title: 't', author: 'a', url: '', additions: 0, deletions: 0, updatedAt: '', headSha: 'abc', isDraft: false, state: 'open',
  labels: [], myReview: null, checks: { passed: 3, failed: 0, pending: 0, total: 3 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 0,
  headRef: 'h', baseRef: 'main', mine: false, reviewDecision: null, reviewers: [], reviewRequested: false,
};
const pr = (p: Partial<PrSummary> = {}): PrSummary => ({ ...base, ...p });
const detail = (p: Partial<PrDetail> = {}): PrDetail => ({ ...base, nodeId: '', body: '', bodyHtml: '', conversation: [], mergeMethods: ['squash'], files: [], checkRuns: [], sinceLastLook: null, ...p });

describe('prStatus', () => {
  it('names each state once', () => {
    expect(prStatus(pr())).toMatchObject({ label: 'Needs your review', tone: 'muted', quiet: true });
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
  it('lists reviews, checks, conflicts, base and open threads, in GitHub order', () => {
    const items = mergeReadiness(detail({ mergeState: 'behind', unresolvedThreads: 2, checks: { passed: 2, failed: 1, pending: 0, total: 3 } }));
    expect(items.map((i) => [i.key, i.tone])).toEqual([['approval', 'muted'], ['checks', 'bad'], ['conflicts', 'ok'], ['base', 'warn'], ['threads', 'warn']]);
    expect(items.find((i) => i.key === 'base')).toMatchObject({ text: 'Out of date with main', action: 'updateBranch' });
    expect(mergeReadiness(detail({ mergeable: false })).find((i) => i.key === 'conflicts')).toMatchObject({ tone: 'bad', action: 'fixConflicts' });
  });

  it('says when conflicts are still being worked out', () => {
    expect(mergeReadiness(detail({ mergeable: null })).find((i) => i.key === 'conflicts')).toMatchObject({ tone: 'muted', text: 'Checking for conflicts' });
  });
});

describe('mergeSummary', () => {
  it('leads with the most urgent problem and counts the rest', () => {
    expect(mergeSummary(detail({ mergeState: 'behind', unresolvedThreads: 1, checks: { passed: 2, failed: 1, pending: 0, total: 3 } }))).toEqual({ tone: 'bad', text: '1 check failing', more: 2 });
    expect(mergeSummary(detail({ mergeable: false, mergeState: 'dirty' }))).toMatchObject({ tone: 'bad', text: 'Conflicts with main', more: 0 });
    expect(mergeSummary(detail({ mergeable: false, checks: { passed: 0, failed: 1, pending: 0, total: 1 } }))).toMatchObject({ text: 'Conflicts with main', more: 1 });
    expect(mergeSummary(detail({ checks: { passed: 1, failed: 0, pending: 2, total: 3 } }))).toMatchObject({ tone: 'run', text: '2 checks running' });
  });

  it('says ready when nothing needs attention, without leading on approval', () => {
    expect(mergeSummary(detail())).toEqual({ tone: 'ok', text: 'Ready once you approve', more: 0 });
    expect(mergeSummary(detail({ myReview: 'approved' }))).toEqual({ tone: 'ok', text: 'Ready to merge', more: 0 });
    expect(mergeSummary(detail({ checks: { passed: 0, failed: 0, pending: 0, total: 0 } }))).toMatchObject({ text: 'Ready once you approve' });
  });
});

describe('merge rules', () => {
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

describe('team reviews', () => {
  const asked = (...logins: string[]) => logins.map((login) => ({ login, state: 'requested' as const }));
  it('puts your own PRs in their own bucket, saying what’s next', () => {
    expect(prStatus(pr({ mine: true, reviewDecision: 'review_required', reviewers: asked('priya') }))).toMatchObject({ bucket: 'mine', label: 'Waiting on priya', who: 'author' });
    expect(prStatus(pr({ mine: true, reviewDecision: 'changes_requested' }))).toMatchObject({ bucket: 'mine', label: 'Changes requested', who: 'you' });
    expect(prStatus(pr({ mine: true, reviewDecision: 'approved' }))).toMatchObject({ bucket: 'mine', label: 'Ready to merge' });
    expect(prStatus(pr({ mine: true, checks: { passed: 0, failed: 1, pending: 0, total: 1 } }))).toMatchObject({ bucket: 'mine', label: '1 check failing' });
  });

  it('leaves a PR to the reviewer who was asked, and keeps yours in Needs you', () => {
    expect(prStatus(pr({ reviewDecision: 'review_required', reviewers: asked('sam') }))).toMatchObject({ bucket: 'waiting', label: 'Waiting on sam' });
    expect(prStatus(pr({ reviewDecision: 'review_required', reviewers: asked('sam', 'calebksmith'), reviewRequested: true }))).toMatchObject({ bucket: 'needs', label: 'Needs your review' });
  });

  it('waits for another approval after yours when the repo needs more', () => {
    expect(prStatus(pr({ myReview: 'approved', reviewDecision: 'review_required' }))).toMatchObject({ bucket: 'waiting', label: 'Needs another approval' });
    expect(prStatus(pr({ reviewDecision: 'approved' }))).toMatchObject({ bucket: 'approved', label: 'Ready to merge' });
  });

  it('blocks merging without approval, and a stacked PR before the one under it', () => {
    expect(mergeBlocker(detail({ mine: true, reviewDecision: 'review_required' }))).toBe('It needs an approval from a reviewer first.');
    expect(mergeBlocker(detail({ reviewDecision: 'changes_requested' }))).toMatch(/new approval/);
    const parent = pr({ number: 7, headRef: 'base-branch' });
    const child = detail({ number: 8, baseRef: 'base-branch', reviewDecision: 'approved' });
    expect(mergeBlocker(child, [parent])).toBe('Merge #7 first. This PR is stacked on it.');
    expect(mergeReadiness(child, [parent])[0]).toMatchObject({ key: 'stack', action: 'openPr', pr: 7 });
  });

  it('says who approved and who’s still asked', () => {
    const items = mergeReadiness(detail({ reviewDecision: 'review_required', reviewers: [{ login: 'dana', state: 'approved' }, ...asked('sam')] }));
    expect(items.find((i) => i.key === 'approval')?.text).toBe('Approved by dana; needs another approval (asked: sam)');
    const me = mergeReadiness(detail({ reviewDecision: 'review_required', reviewers: asked('calebksmith') }), [], 'calebksmith');
    expect(me.find((i) => i.key === 'approval')?.text).toBe('Needs an approval (asked: you)');
  });
});
