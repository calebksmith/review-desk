import type { Comment, ConversationItem, ReviewVerdict } from './protocol';

// Turns a PR's comments, reviews and review threads from GitHub's GraphQL API into one timeline.

export interface RawComment { author: { login: string } | null; createdAt: string; body: string; bodyHTML: string; url: string }
export interface RawReview {
  author: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string | null;
  body: string;
  bodyHTML: string;
  url: string;
}
export interface RawThread { id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; originalLine: number | null; comments: { nodes: RawComment[] } }

/** Comment fields to request on PR comments and on each review thread's comments. */
export const COMMENT_FIELDS = 'author { login } createdAt body bodyHTML url';

const comment = (c: RawComment): Comment => ({ author: c.author?.login ?? 'ghost', createdAt: c.createdAt, html: c.bodyHTML, text: c.body, url: c.url, isNew: false });

const VERDICT: Record<Exclude<RawReview['state'], 'PENDING'>, ReviewVerdict> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed',
};

export function toConversation(comments: RawComment[], reviews: RawReview[], threads: RawThread[]): ConversationItem[] {
  const items: ConversationItem[] = comments.map((c) => ({ kind: 'comment', comment: comment(c) }));
  for (const r of reviews) {
    // A pending review is the viewer's unsent draft. A bare "commented" review only wraps line comments,
    // which show up in their threads.
    if (r.state === 'PENDING' || !r.submittedAt) continue;
    if (r.state === 'COMMENTED' && !r.body.trim()) continue;
    items.push({ kind: 'review', verdict: VERDICT[r.state], comment: comment({ ...r, createdAt: r.submittedAt }) });
  }
  for (const t of threads) {
    if (!t.comments.nodes.length) continue;
    items.push({ kind: 'thread', id: t.id, path: t.path, line: t.line ?? t.originalLine, resolved: t.isResolved, outdated: t.isOutdated, comments: t.comments.nodes.map(comment) });
  }
  return items.sort((a, b) => Date.parse(startedAt(a)) - Date.parse(startedAt(b)));
}

export function startedAt(item: ConversationItem): string {
  return item.kind === 'thread' ? item.comments[0]?.createdAt ?? '' : item.comment.createdAt;
}

/** Flags what others posted after the reviewer last opened the PR. On a first look nothing is new. */
export function markNew(items: ConversationItem[], seenAt: string | null, me: string): ConversationItem[] {
  const since = seenAt ? Date.parse(seenAt) : NaN;
  const flag = (c: Comment): Comment => ({ ...c, isNew: !Number.isNaN(since) && c.author !== me && Date.parse(c.createdAt) > since });
  return items.map((it) => (it.kind === 'thread' ? { ...it, comments: it.comments.map(flag) } : { ...it, comment: flag(it.comment) }));
}

/** How many comments a conversation holds, how many are new, and how many threads are still open. */
export function conversationCounts(items: ConversationItem[]): { comments: number; fresh: number; unresolved: number } {
  const all = items.flatMap((it) => (it.kind === 'thread' ? it.comments : [it.comment]));
  return {
    comments: all.length,
    fresh: all.filter((c) => c.isNew).length,
    unresolved: items.filter((it) => it.kind === 'thread' && !it.resolved).length,
  };
}
