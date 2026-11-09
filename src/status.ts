import type { PrDetail, PrSummary } from './protocol';

// One vocabulary for a PR's state. The queue row, the PR header and the sidebar all
// read from here, so the same PR never has two names. Red ('bad') means it blocks merge.

export type Tone = 'muted' | 'run' | 'warn' | 'bad' | 'ok';
export type Bucket = 'needs' | 'waiting' | 'approved' | 'merged';

export interface PrStatus {
  label: string;
  tone: Tone;
  bucket: Bucket;
  /** Who acts next: the reviewer, the PR's author, or nobody. */
  who: 'you' | 'author' | null;
}

export function prStatus(p: PrSummary): PrStatus {
  if (p.state === 'merged') return { label: 'Merged', tone: 'muted', bucket: 'merged', who: null };
  if (p.isDraft) return { label: 'Draft', tone: 'muted', bucket: 'waiting', who: 'author' };
  if (p.mergeable === false || p.mergeState === 'dirty') return { label: 'Has conflicts', tone: 'bad', bucket: 'needs', who: 'you' };
  if (p.checks.failed) return { label: plural(p.checks.failed, 'check') + ' failing', tone: 'bad', bucket: 'needs', who: 'you' };
  if (p.myReview === 'changes_requested') return { label: 'Changes requested', tone: 'muted', bucket: 'waiting', who: 'author' };
  if (p.myReview === 'approved') {
    if (p.checks.pending) return { label: 'Approved · checks running', tone: 'run', bucket: 'approved', who: null };
    if (p.mergeState === 'behind') return { label: 'Approved · behind base', tone: 'warn', bucket: 'approved', who: 'you' };
    return { label: 'Ready to merge', tone: 'ok', bucket: 'approved', who: 'you' };
  }
  return { label: 'Needs your review', tone: 'warn', bucket: 'needs', who: 'you' };
}

export interface ReadinessItem {
  key: 'conflicts' | 'base' | 'checks' | 'threads';
  tone: Tone;
  text: string;
  action?: 'updateBranch' | 'showChecks' | 'openThreads';
}

/** What stands between this PR and a merge, in the order a reviewer should deal with it. */
export function mergeReadiness(pr: PrDetail): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const c = pr.checks;
  if (pr.mergeable === false || pr.mergeState === 'dirty') items.push({ key: 'conflicts', tone: 'bad', text: `Conflicts with ${pr.baseRef}` });
  else if (pr.mergeable === null) items.push({ key: 'conflicts', tone: 'muted', text: 'Checking for conflicts' });
  else items.push({ key: 'conflicts', tone: 'ok', text: 'No conflicts' });

  if (pr.mergeState === 'behind') items.push({ key: 'base', tone: 'warn', text: `Behind ${pr.baseRef}`, action: 'updateBranch' });
  else items.push({ key: 'base', tone: 'ok', text: `Up to date with ${pr.baseRef}` });

  if (c.failed) items.push({ key: 'checks', tone: 'bad', text: plural(c.failed, 'check') + ' failing', action: 'showChecks' });
  else if (c.pending) items.push({ key: 'checks', tone: 'run', text: plural(c.pending, 'check') + ' running', action: 'showChecks' });
  else if (!c.total) items.push({ key: 'checks', tone: 'muted', text: 'No checks' });
  else items.push({ key: 'checks', tone: 'ok', text: `All ${plural(c.total, 'check')} passed` });

  if (pr.unresolvedThreads) items.push({ key: 'threads', tone: 'warn', text: plural(pr.unresolvedThreads, 'unresolved comment thread'), action: 'openThreads' });
  return items;
}

/** Why Merge can't run at all, or null. Only conflicts: GitHub refuses to merge those. */
export function mergeBlocker(pr: PrDetail): string | null {
  if (pr.mergeable === false || pr.mergeState === 'dirty') return `Resolve the conflicts with ${pr.baseRef} first.`;
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
