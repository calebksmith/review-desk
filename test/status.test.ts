import { describe, expect, it } from 'vitest';
import { toMergeState, mergeMethods } from '../src/github';
import type { PrDetail, PrSummary } from '../src/protocol';
import { bulkMergeable, bulkSkipReason, byPriority, mergeBlocker, mergeReadiness, mergeSummary, mergeWarning, priority, prStatus } from '../src/status';

const base: PrSummary = {
  repo: 'acme/web', number: 1, title: 't', author: 'a', url: '', additions: 0, deletions: 0, updatedAt: '', headSha: 'abc', isDraft: false, state: 'open',
  labels: [], myReview: null, myReviewSha: null, checks: { passed: 3, failed: 0, pending: 0, total: 3 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 0,
  headRef: 'h', baseRef: 'main', mine: false, reviewDecision: null, reviewers: [], reviewRequested: false,
  createdAt: '2026-01-01T00:00:00Z', requestedAt: null, milestone: null, dependsOn: [], linear: null, findingCounts: { p0: 0, p1: 0 },
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
    expect(prStatus(pr({ reviewDecision: 'approved' }))).toMatchObject({ bucket: 'approved', label: 'Approved', tone: 'muted', who: 'author' });
  });

  it('blocks merging without approval, and a stacked PR before the one under it', () => {
    expect(mergeBlocker(detail({ mine: true, reviewDecision: 'review_required' }))).toBe('It needs an approval from a reviewer first.');
    expect(mergeBlocker(detail({ reviewDecision: 'changes_requested' }))).toMatch(/new approval/);
    const parent = pr({ number: 7, headRef: 'base-branch' });
    const child = detail({ number: 8, baseRef: 'base-branch', reviewDecision: 'approved' });
    expect(mergeBlocker(child, [parent])).toBe('Merge #7 first. This PR is stacked on it.');
    expect(mergeReadiness(child, [parent])[0]).toMatchObject({ key: 'stack', action: 'openPr', pr: 'acme/web#7' });
    // A branch with the same name in another repo isn't a parent.
    expect(mergeBlocker(child, [{ ...parent, repo: 'acme/other' }])).toBeNull();
  });

  it('says who approved and who’s still asked', () => {
    const items = mergeReadiness(detail({ reviewDecision: 'review_required', reviewers: [{ login: 'dana', state: 'approved' }, ...asked('sam')] }));
    expect(items.find((i) => i.key === 'approval')?.text).toBe('Approved by dana; needs another approval (asked: sam)');
    const me = mergeReadiness(detail({ reviewDecision: 'review_required', reviewers: asked('calebksmith') }), [], 'calebksmith');
    expect(me.find((i) => i.key === 'approval')?.text).toBe('Needs an approval (asked: you)');
  });
});

describe('priority', () => {
  const asked = [{ login: 'me', state: 'requested' as const }];
  it('puts what you can act on first, a review asked of you by name above all', () => {
    const order = [
      pr({ number: 1, reviewDecision: 'review_required', reviewers: [{ login: 'sam', state: 'requested' }] }), // someone else's review
      pr({ number: 2 }), // unassigned
      pr({ number: 3, mine: true, reviewDecision: 'changes_requested' }), // yours, your move
      pr({ number: 4, reviewDecision: 'review_required', reviewers: asked, reviewRequested: true }), // asked of you
      pr({ number: 5, reviewDecision: 'approved' }), // someone else's, theirs to merge
      pr({ number: 6, state: 'merged' }),
    ].sort(byPriority);
    expect(order.map((p) => p.number)).toEqual([4, 3, 2, 1, 5, 6]);
    expect(order.map((p) => priority(p).section)).toEqual(['you', 'you', 'you', 'others', 'others', 'merged']);
  });

  it('leaves merging to the author on a team, and to you alone', () => {
    expect(prStatus(pr({ reviewDecision: 'approved' })).who).toBe('author');
    expect(prStatus(pr({ myReview: 'approved' })).who).toBe('you');
    expect(prStatus(pr({ mine: true, reviewDecision: 'approved' })).who).toBe('you');
  });
});

describe('re-review', () => {
  it('comes back to you when the author pushes after your changes request, or asks again', () => {
    expect(prStatus(pr({ myReview: 'changes_requested', myReviewSha: 'abc' }))).toMatchObject({ label: 'Changes requested', bucket: 'waiting' });
    expect(prStatus(pr({ myReview: 'changes_requested', myReviewSha: 'old' }))).toMatchObject({ label: 'Re-review', bucket: 'needs', who: 'you' });
    expect(prStatus(pr({ myReview: 'approved', myReviewSha: 'old', reviewDecision: 'review_required', reviewRequested: true }))).toMatchObject({ label: 'Re-review' });
    expect(priority(pr({ myReview: 'changes_requested', myReviewSha: 'old' })).rank).toBe(0.5);
  });

  it('counts open P0 and P1 findings for the checklist', () => {
    const t = (severity: number | null, resolved = false) => ({ kind: 'thread' as const, id: 'x', path: 'a', line: 1, resolved, outdated: false, comments: [], severity });
    const items = mergeReadiness(detail({ conversation: [t(1), t(1), t(0, true), t(2)] }));
    expect(items.find((i) => i.key === 'findings')).toMatchObject({ tone: 'warn', text: '2 P1 findings open', action: 'nextFinding' });
  });
});
