import type { CheckRun, ConversationItem, PrDetail, PrSummary } from './protocol';
import { mergeReadiness, mergeSummary, prStatus, type ReadinessItem, type Tone } from './status';

// The status card at the top of Overview (and in the header's popover): one place that says what this PR
// needs and whose turn it is, with Checks, Findings, Comments and Approvals as bars of one piece per item.

export type PartKey = 'checks' | 'findings' | 'comments' | 'approvals';

export interface Part {
  key: PartKey;
  label: string;
  summary: string;
  tone: Tone;
  /** It gates merging: required checks, or required approvals. */
  locked: boolean;
  /** One piece per check, finding, thread or approval, in its state's tone. */
  segments: Tone[];
}

export interface Card {
  tone: Tone;
  title: string;
  /** Whose turn it is, or (when ready) the short version of every part. */
  sub: string;
  ready: boolean;
  parts: Part[];
  /** What stops a merge outright and has its own fix: conflicts, out of date, a PR below in its stack. */
  blockers: ReadinessItem[];
}

type Thread = Extract<ConversationItem, { kind: 'thread' }>;
const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'];
export const isFailing = (r: CheckRun) => r.status === 'completed' && FAILED.includes(r.conclusion ?? '');
export const isSkipped = (r: CheckRun) => r.status === 'completed' && (r.conclusion === 'skipped' || r.conclusion === 'neutral');

function checksPart(pr: PrDetail): Part {
  const runs = pr.checkRuns;
  const failing = runs.filter(isFailing);
  const requiredFailing = failing.filter((r) => r.required);
  const running = runs.filter((r) => r.status !== 'completed');
  const segments: Tone[] = runs.map((r) => (isFailing(r) ? (r.required ? 'bad' : 'warn') : r.status !== 'completed' ? 'run' : isSkipped(r) ? 'muted' : 'ok'));
  const locked = runs.some((r) => r.required);
  if (!runs.length) return { key: 'checks', label: 'Checks', summary: 'None', tone: 'muted', locked, segments };
  if (failing.length) return { key: 'checks', label: 'Checks', summary: `${failing.length} failing${requiredFailing.length ? '' : ', optional'}`, tone: requiredFailing.length ? 'bad' : 'warn', locked, segments };
  if (running.length) return { key: 'checks', label: 'Checks', summary: `${running.length} running`, tone: 'run', locked, segments };
  return { key: 'checks', label: 'Checks', summary: `All ${runs.length} passed`, tone: 'ok', locked, segments };
}

function findingsPart(threads: Thread[]): Part {
  const all = threads.filter((t) => t.severity != null);
  const open = all.filter((t) => !t.resolved).sort((a, b) => a.severity! - b.severity!);
  const segments: Tone[] = all.map((t) => (t.resolved ? 'ok' : t.severity === 0 ? 'bad' : t.severity === 1 ? 'warn' : 'muted'));
  if (!all.length) return { key: 'findings', label: 'Findings', summary: 'None', tone: 'muted', locked: false, segments };
  if (!open.length) return { key: 'findings', label: 'Findings', summary: 'All resolved', tone: 'ok', locked: false, segments };
  const top = open[0]!.severity!;
  const same = open.filter((t) => t.severity === top).length;
  return { key: 'findings', label: 'Findings', summary: `${same} P${top} open${open.length > same ? ` +${open.length - same}` : ''}`, tone: top === 0 ? 'bad' : top === 1 ? 'warn' : 'muted', locked: false, segments };
}

function commentsPart(threads: Thread[]): Part {
  const plain = threads.filter((t) => t.severity == null);
  const open = plain.filter((t) => !t.resolved);
  const segments: Tone[] = plain.map((t) => (t.resolved ? 'ok' : 'warn'));
  if (!plain.length) return { key: 'comments', label: 'Comments', summary: 'None', tone: 'muted', locked: false, segments };
  if (!open.length) return { key: 'comments', label: 'Comments', summary: 'All resolved', tone: 'ok', locked: false, segments };
  return { key: 'comments', label: 'Comments', summary: `${open.length} unresolved`, tone: 'warn', locked: false, segments };
}

function approvalsPart(pr: PrDetail, me: string): Part {
  const name = (l: string) => (l === me ? 'you' : l);
  const people = pr.reviewers.filter((r) => r.state !== 'commented');
  if (pr.reviewDecision === null) {
    // No review rules: your approval is the one that counts.
    const ok = pr.myReview === 'approved';
    return { key: 'approvals', label: 'Approvals', summary: ok ? 'Approved by you' : pr.myReview === 'changes_requested' ? 'You requested changes' : 'Not yet', tone: ok ? 'ok' : 'muted', locked: false, segments: [ok ? 'ok' : pr.myReview === 'changes_requested' ? 'bad' : 'muted'] };
  }
  const segments: Tone[] = people.map((r) => (r.state === 'approved' ? 'ok' : r.state === 'changes_requested' ? 'bad' : 'run'));
  const approved = people.filter((r) => r.state === 'approved');
  if (pr.reviewDecision === 'approved') return { key: 'approvals', label: 'Approvals', summary: `Approved by ${approved.map((r) => name(r.login)).join(', ') || 'a reviewer'}`, tone: 'ok', locked: true, segments };
  if (pr.reviewDecision === 'changes_requested') return { key: 'approvals', label: 'Approvals', summary: 'Changes requested', tone: 'warn', locked: true, segments };
  // Still needs someone: show the gap as an empty piece.
  return { key: 'approvals', label: 'Approvals', summary: approved.length ? '1 more needed' : 'Needed', tone: 'warn', locked: true, segments: [...segments.filter((t) => t !== 'run'), 'muted'] };
}

/** Whose turn it is, in a few words. */
function whoNext(pr: PrDetail): string {
  const s = prStatus(pr);
  const asked = pr.reviewers.filter((r) => r.state === 'requested').map((r) => r.login);
  if (pr.mine) {
    if (pr.reviewDecision === 'changes_requested') return 'Your move: address the requested changes.';
    if (pr.reviewDecision === 'review_required') return asked.length ? `Waiting on ${asked.join(', ')} to review.` : 'Waiting on a review.';
    return '';
  }
  if (s.who === 'you') return s.label === 'Re-review' ? `${pr.author} updated it since your review.` : 'Your review is next.';
  if (s.who === 'author') return `Waiting on ${pr.author}.`;
  return '';
}

export function statusCard(pr: PrDetail, queue: readonly PrSummary[], me: string): Card {
  const threads = pr.conversation.filter((it): it is Thread => it.kind === 'thread');
  const parts = [checksPart(pr), findingsPart(threads), commentsPart(threads), approvalsPart(pr, me)];
  const sum = mergeSummary(pr, queue, me);
  const blockers = mergeReadiness(pr, queue, me).filter((it) => it.key === 'draft' || (it.key === 'conflicts' && it.tone === 'bad') || (it.key === 'base' && it.tone === 'warn') || it.key === 'stack');
  const ready = sum.tone === 'ok';
  const sub = ready
    ? parts.filter((p) => p.summary !== 'None').map((p) => `${p.label.toLowerCase()}: ${p.summary.charAt(0).toLowerCase()}${p.summary.slice(1)}`).join(' · ')
    : whoNext(pr);
  return { tone: sum.tone, title: sum.text, sub, ready, parts, blockers };
}

/** "38s", "3m", "1h 5m". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}
