import type { PrSummary } from './protocol';
import { prStatus, type Bucket } from './status';

// The sidebar's PR list: the same buckets as the queue's filters, in the order a reviewer works them.

export interface QueueGroup { bucket: Bucket; label: string; prs: PrSummary[] }

const GROUPS: { bucket: Bucket; label: string }[] = [
  { bucket: 'needs', label: 'Needs you' },
  { bucket: 'waiting', label: 'Waiting on author' },
  { bucket: 'approved', label: 'Approved' },
  { bucket: 'merged', label: 'Merged' },
];

/** Non-empty groups. Within each, what blocks a merge comes first, then the most recently updated. */
export function queueGroups(queue: PrSummary[]): QueueGroup[] {
  const order = (p: PrSummary) => (prStatus(p).tone === 'bad' ? 0 : 1);
  return GROUPS.map((g) => ({
    ...g,
    prs: queue.filter((p) => prStatus(p).bucket === g.bucket).sort((a, b) => order(a) - order(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  })).filter((g) => g.prs.length);
}

/** The number on the sidebar icon: open PRs waiting on the reviewer. */
export function needsYou(queue: PrSummary[]): number {
  return queue.filter((p) => prStatus(p).bucket === 'needs').length;
}
