import type { PrDetail, PrSummary, Reviewer } from './protocol';
import { parentOf } from './stacks';

// One vocabulary for a PR's state. The queue row, the PR header and the sidebar all
// read from here, so the same PR never has two names. Red ('bad') means it blocks merge.

export type Tone = 'muted' | 'run' | 'warn' | 'bad' | 'ok';
export type Bucket = 'needs' | 'mine' | 'waiting' | 'approved' | 'merged';

export interface PrStatus {
  label: string;
  /** The usual state for its bucket ("Needs your review", "Merged"): lists can leave it unsaid. */
  quiet?: boolean;
  tone: Tone;
  bucket: Bucket;
  /** Who acts next: the reviewer, the PR's author, or nobody. */
  who: 'you' | 'author' | null;
}

/**
 * A PR's one status. Open PRs the reviewer opened go in their own bucket ("Your PRs"), whatever their state,
 * the way GitHub's dashboard keeps Created apart from Review requests; the label says what's next.
 */
export function prStatus(p: PrSummary): PrStatus {
  const s = baseStatus(p);
  return p.mine && p.state === 'open' ? { ...s, bucket: 'mine', quiet: false } : s;
}

function baseStatus(p: PrSummary): PrStatus {
  if (p.state === 'merged') return { label: 'Merged', tone: 'muted', bucket: 'merged', who: null, quiet: true };
  if (p.isDraft) return { label: 'Draft', tone: 'muted', bucket: 'waiting', who: 'author' };
  if (p.mergeable === false || p.mergeState === 'dirty') return { label: 'Has conflicts', tone: 'bad', bucket: 'needs', who: 'you' };
  if (p.checks.failed) return { label: plural(p.checks.failed, 'check') + ' failing', tone: 'bad', bucket: 'needs', who: 'you' };
  // Your own PR: you can't approve it, so it's about what reviewers have said.
  if (p.mine) {
    if (p.reviewDecision === 'changes_requested') return { label: 'Changes requested', tone: 'warn', bucket: 'needs', who: 'you' };
    if (p.reviewDecision === 'review_required') return { label: waitingOn(p.reviewers), tone: 'muted', bucket: 'waiting', who: 'author' };
    return approved(p);
  }
  if (p.myReview === 'changes_requested') return { label: 'Changes requested', tone: 'muted', bucket: 'waiting', who: 'author' };
  if (p.myReview === 'approved') {
    if (p.reviewDecision === 'review_required') return { label: 'Needs another approval', tone: 'muted', bucket: 'waiting', who: 'author' };
    return approved(p);
  }
  if (p.reviewDecision === 'approved') return approved(p);
  if (p.reviewDecision === 'changes_requested') return { label: 'Changes requested', tone: 'muted', bucket: 'waiting', who: 'author' };
  // Someone else was asked and you weren't: it's theirs to review.
  const asked = p.reviewers.filter((r) => r.state === 'requested');
  if (asked.length && !p.reviewRequested) return { label: waitingOn(p.reviewers), tone: 'muted', bucket: 'waiting', who: 'author' };
  // The normal state of a new PR: no colour, so the queue only lights up for real problems.
  return { label: 'Needs your review', tone: 'muted', bucket: 'needs', who: 'you', quiet: true };
}

function approved(p: PrSummary): PrStatus {
  if (p.checks.pending) return { label: 'Approved · checks running', tone: 'run', bucket: 'approved', who: null };
  if (p.mergeState === 'behind') return { label: 'Approved · behind base', tone: 'warn', bucket: 'approved', who: 'you' };
  return { label: 'Ready to merge', tone: 'ok', bucket: 'approved', who: 'you' };
}

/** "Waiting on priya" or "Waiting on priya, sam"; "Waiting on review" when nobody's been asked by name. */
function waitingOn(reviewers: Reviewer[]): string {
  const asked = reviewers.filter((r) => r.state === 'requested').map((r) => r.login);
  return asked.length ? `Waiting on ${asked.join(', ')}` : 'Waiting on review';
}

/** Reviewers' names, with the signed-in reviewer as "you". */
const names = (rs: Reviewer[], me = '') => rs.map((r) => (r.login === me ? 'you' : r.login)).join(', ');

export interface ReadinessItem {
  key: 'stack' | 'approval' | 'checks' | 'conflicts' | 'base' | 'threads';
  tone: Tone;
  text: string;
  action?: 'updateBranch' | 'showChecks' | 'openThreads' | 'fixConflicts' | 'openPr';
  /** The PR an openPr action opens. */
  pr?: number;
}

/**
 * The merge checklist, in GitHub's merge-box order and wording: reviews, checks, conflicts, base, threads.
 * A stacked PR first says what it's stacked on. Unresolved threads only show when there are some.
 */
export function mergeReadiness(pr: PrDetail, queue: readonly PrSummary[] = [], me = ''): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const c = pr.checks;
  const parent = parentOf(pr, queue);
  if (parent) items.push({ key: 'stack', tone: 'warn', text: `Stacked on #${parent.number}; merge it first`, action: 'openPr', pr: parent.number });

  const approvedBy = pr.reviewers.filter((r) => r.state === 'approved');
  const changesBy = pr.reviewers.filter((r) => r.state === 'changes_requested');
  const asked = pr.reviewers.filter((r) => r.state === 'requested');
  if (pr.reviewDecision === null) {
    // No review rules (a solo repo): your approval is the review.
    if (pr.myReview === 'approved') items.push({ key: 'approval', tone: 'ok', text: 'Changes approved' });
    else if (pr.myReview === 'changes_requested') items.push({ key: 'approval', tone: 'warn', text: 'You requested changes' });
    else items.push({ key: 'approval', tone: 'muted', text: 'Not approved yet' });
  } else if (pr.reviewDecision === 'changes_requested') {
    items.push({ key: 'approval', tone: 'warn', text: `Changes requested by ${names(changesBy, me) || 'a reviewer'}` });
  } else if (pr.reviewDecision === 'approved') {
    items.push({ key: 'approval', tone: 'ok', text: `Approved by ${names(approvedBy, me) || 'a reviewer'}` });
  } else {
    const so = approvedBy.length ? `Approved by ${names(approvedBy, me)}; needs another approval` : 'Needs an approval';
    items.push({ key: 'approval', tone: pr.mine || pr.myReview === 'approved' ? 'warn' : 'muted', text: `${so}${asked.length ? ` (asked: ${names(asked, me)})` : ''}` });
  }

  if (c.failed) items.push({ key: 'checks', tone: 'bad', text: plural(c.failed, 'check') + ' failing', action: 'showChecks' });
  else if (c.pending) items.push({ key: 'checks', tone: 'run', text: plural(c.pending, 'check') + ' running', action: 'showChecks' });
  else if (!c.total) items.push({ key: 'checks', tone: 'muted', text: 'No checks' });
  else items.push({ key: 'checks', tone: 'ok', text: `All ${plural(c.total, 'check')} passed`, action: 'showChecks' });

  if (pr.mergeable === false || pr.mergeState === 'dirty') items.push({ key: 'conflicts', tone: 'bad', text: `Conflicts with ${pr.baseRef}`, action: 'fixConflicts' });
  else if (pr.mergeable === null) items.push({ key: 'conflicts', tone: 'muted', text: 'Checking for conflicts' });
  else items.push({ key: 'conflicts', tone: 'ok', text: `No conflicts with ${pr.baseRef}` });

  if (pr.mergeState === 'behind') items.push({ key: 'base', tone: 'warn', text: `Out of date with ${pr.baseRef}`, action: 'updateBranch' });
  else items.push({ key: 'base', tone: 'ok', text: `Up to date with ${pr.baseRef}` });

  if (pr.unresolvedThreads) items.push({ key: 'threads', tone: 'warn', text: plural(pr.unresolvedThreads, 'unresolved thread'), action: 'openThreads' });
  return items;
}

const URGENCY: Record<Tone, number> = { bad: 0, run: 1, warn: 2, muted: 3, ok: 4 };
// Within a tone, what blocks a merge outright comes first.
const LEAD: Record<ReadinessItem['key'], number> = { conflicts: 0, stack: 1, checks: 2, approval: 3, base: 4, threads: 5 };

/**
 * The one line beside the header's button: the most urgent item, and how many others need attention.
 * When nothing does, it says the PR is ready. "Not approved yet" never leads, since Approve is the button.
 */
export function mergeSummary(pr: PrDetail, queue: readonly PrSummary[] = [], me = ''): { tone: Tone; text: string; more: number } {
  const attention = mergeReadiness(pr, queue, me)
    .filter((it) => it.tone !== 'ok' && !(it.key === 'approval' && it.tone === 'muted') && !(it.key === 'checks' && it.text === 'No checks'))
    .sort((a, b) => URGENCY[a.tone] - URGENCY[b.tone] || LEAD[a.key] - LEAD[b.key]);
  const first = attention[0];
  if (!first) return { tone: 'ok', text: pr.myReview === 'approved' || pr.mine || pr.reviewDecision === 'approved' ? 'Ready to merge' : 'Ready once you approve', more: 0 };
  return { tone: first.tone, text: first.text, more: attention.length - 1 };
}

/**
 * Why Merge can't run at all, or null: conflicts and missing approvals (GitHub refuses both), and a stack
 * merged out of order (the PR below has to go first, or this one lands in its branch instead of main).
 */
export function mergeBlocker(pr: PrDetail, queue: readonly PrSummary[] = []): string | null {
  if (pr.mergeable === false || pr.mergeState === 'dirty') return `Resolve the conflicts with ${pr.baseRef} first.`;
  const parent = parentOf(pr, queue);
  if (parent) return `Merge #${parent.number} first. This PR is stacked on it.`;
  if (pr.reviewDecision === 'changes_requested') return 'Changes were requested. It needs a new approval.';
  if (pr.reviewDecision === 'review_required') return pr.myReview === 'approved' ? 'It needs another approval before it can merge.' : 'It needs an approval from a reviewer first.';
  return null;
}

/** Failing checks don't block a merge; the reviewer can merge anyway once they've been told. Null when none fail. */
export function mergeWarning(pr: PrDetail): string | null {
  if (!pr.checks.failed) return null;
  const names = failingChecks(pr);
  return names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} failing` : `${plural(pr.checks.failed, 'check')} failing`;
}

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'];
export function failingChecks(pr: PrDetail): string[] {
  return pr.checkRuns.filter((r) => r.status === 'completed' && FAILED.includes(r.conclusion ?? '')).map((r) => r.name);
}

/** Dependabot opens PRs as the "dependabot" app; REST and GraphQL spell its login differently. */
export function isDependabot(p: PrSummary): boolean {
  return ['dependabot', 'dependabot[bot]', 'app/dependabot'].includes(p.author);
}

/**
 * Why a PR can't go in a one-click bulk merge, or null if it can: open, no conflicts, and every check
 * finished and passed. Required approvals aren't checked here; the bulk merge approves first and
 * GitHub says if it needs more.
 */
export function bulkSkipReason(p: PrSummary): string | null {
  if (p.state === 'merged') return 'already merged';
  if (p.isDraft) return 'draft';
  if (p.mergeable === false || p.mergeState === 'dirty') return 'conflicts with its base';
  if (p.mergeable === null) return 'GitHub still checking for conflicts';
  if (p.checks.failed) return `${plural(p.checks.failed, 'check')} failing`;
  if (p.checks.pending) return 'checks still running';
  return null;
}

/** Dependabot PRs that are safe to approve and merge without opening them. */
export function bulkMergeable(queue: PrSummary[]): PrSummary[] {
  return queue.filter((p) => isDependabot(p) && !bulkSkipReason(p)).sort((a, b) => a.number - b.number);
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
