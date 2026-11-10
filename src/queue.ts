import type { DiffLine, Draft, PrDetail } from './protocol';

/**
 * Something in the diff waiting on the reviewer: an open thread they haven't answered yet, or a suggestion
 * from their agent they haven't kept or deleted. A thread is answered when the reviewer has a reply held back
 * for it or wrote its last comment (a thread they started is waiting on the author). Answered threads and the
 * reviewer's own drafts need nothing more, so they aren't in the queue.
 */
export interface QueueItem {
  kind: 'thread' | 'draft';
  id: string;
  path: string;
  line: number | null;
  side: 'RIGHT' | 'LEFT';
  severity: number | null;
}

/** What ] and [ step through: most severe first (unmarked last), then by file and line. */
export function reviewQueue(pr: PrDetail, drafts: readonly Draft[], me: string): QueueItem[] {
  const answered = new Set(drafts.filter((d) => d.replyTo && d.from === 'you').map((d) => d.replyTo));
  const items: QueueItem[] = [];
  for (const it of pr.conversation) {
    if (it.kind !== 'thread' || it.resolved || answered.has(it.id) || (me && it.comments.at(-1)?.author === me)) continue;
    items.push({ kind: 'thread', id: it.id, path: it.path, line: it.line, side: 'RIGHT', severity: it.severity });
  }
  for (const d of drafts) {
    if (d.from !== 'agent' || d.replyTo) continue;
    items.push({ kind: 'draft', id: d.id, path: d.path, line: d.line, side: d.side, severity: d.severity ?? null });
  }
  return items.sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** For the file list: how many items each file has, and the most severe one. */
export function fileMarks(queue: readonly QueueItem[]): Map<string, { count: number; severity: number | null }> {
  const out = new Map<string, { count: number; severity: number | null }>();
  for (const q of queue) {
    const m = out.get(q.path);
    // The queue is sorted most severe first, so the first item seen for a file sets its severity.
    if (m) m.count++;
    else out.set(q.path, { count: 1, severity: q.severity });
  }
  return out;
}

/**
 * The item before or after `current`, wrapping around. With no current item, the first (or last). Null when
 * nothing else is left: stepping off the only item has nowhere to go.
 */
export function stepQueue(queue: readonly QueueItem[], current: string | null, dir: 1 | -1): QueueItem | null {
  const at = queue.findIndex((q) => q.id === current);
  if (at < 0) return (dir > 0 ? queue[0] : queue[queue.length - 1]) ?? null;
  if (queue.length < 2) return null;
  return queue[(at + dir + queue.length) % queue.length]!;
}

/** Lines shown above and below each comment when the diff shows only code near comments. */
export const NEAR_BEFORE = 6;
export const NEAR_AFTER = 3;

/**
 * Only the lines near these comments, with a gap marker for each run left out. A comment's code is usually
 * above it, so more lines show above than below. Comments on lines this diff doesn't have show nothing.
 */
export function nearLines(lines: readonly DiffLine[], at: readonly { side: 'RIGHT' | 'LEFT'; line: number | null }[]): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === 'gap') return;
    const hit = at.some((a) => a.line != null && (a.side === 'LEFT' ? l.kind === 'del' && l.oldNo === a.line : l.kind !== 'del' && l.newNo === a.line));
    if (!hit) return;
    for (let j = Math.max(0, i - NEAR_BEFORE); j <= Math.min(lines.length - 1, i + NEAR_AFTER); j++) keep.add(j);
  });
  if (!keep.size) return [];
  const out: DiffLine[] = [];
  // A run of left-out lines becomes one gap. Its count is known only if every gap inside it said how many.
  let hidden: number | null = 0;
  let open = false;
  lines.forEach((l, i) => {
    if (keep.has(i) && l.kind !== 'gap') {
      if (open) out.push({ kind: 'gap', hidden });
      open = false; hidden = 0;
      out.push(l);
      return;
    }
    open = true;
    if (hidden != null) hidden = l.kind === 'gap' ? (l.hidden == null ? null : hidden + l.hidden) : hidden + 1;
  });
  if (open) out.push({ kind: 'gap', hidden });
  return out;
}
