import type { PrSummary } from './protocol';
import { DEFAULT_BLOCKER_LABELS } from './signals';
import { priority, priorityOrder, prStatus, type Bucket } from './status';

// The sidebar's PR list: the same buckets as the queue's filters, in the order a reviewer works them.

export interface QueueGroup { bucket: Bucket; label: string; prs: PrSummary[] }

const GROUPS: { bucket: Bucket; label: string }[] = [
  { bucket: 'needs', label: 'Needs you' },
  { bucket: 'mine', label: 'Your PRs' },
  { bucket: 'waiting', label: 'Waiting on others' },
  { bucket: 'approved', label: 'Approved' },
  { bucket: 'merged', label: 'Merged' },
];

/** Non-empty groups, each in priority order: what you can act on first, blocking problems first within that. */
export function queueGroups(queue: PrSummary[], blockerLabels: readonly string[] = DEFAULT_BLOCKER_LABELS): QueueGroup[] {
  const order = priorityOrder({ queue, blockerLabels });
  return GROUPS.map((g) => ({ ...g, prs: queue.filter((p) => prStatus(p).bucket === g.bucket).sort(order) })).filter((g) => g.prs.length);
}

/** The number on the sidebar icon: every open PR where it's the reviewer's turn. */
export function needsYou(queue: PrSummary[]): number {
  return queue.filter((p) => priority(p).section === 'you').length;
}
