import type { Comment, CommentAction, ConversationItem, PrDetail, PrSummary } from './protocol';
import { plural } from './status';

// When Review Desk refreshes on its own, and what it says when something arrived. Refreshing only happens
// while you can see it, slows down when GitHub's hourly allowance runs low, and catches up when you come back.

export const QUEUE_EVERY = 5 * 60_000;
export const PR_EVERY = 60_000;
export const PR_WAITING_EVERY = 30_000;
/** Coming back to VS Code or the panel refreshes anything older than this. */
export const STALE_ON_RETURN = 60_000;

export interface Budget { remaining: number; limit: number; resetAt: string }

export interface RefreshState {
  now: number;
  /** VS Code has focus, and Review Desk (the panel or the sidebar) is on screen. */
  watching: boolean;
  queueAt: number;
  /** When the open PR last loaded; null when no PR is open. */
  prAt: number | null;
  /** Something on the open PR is expected to change soon: checks running, a reviewer asked and not replied. */
  waiting: boolean;
  budget: Budget | null;
}

/** Below a fifth of GitHub's hourly allowance, refreshing on its own waits until the allowance resets. */
export function budgetLow(b: Budget | null, now: number): boolean {
  return !!b && b.remaining < b.limit * 0.2 && Date.parse(b.resetAt) > now;
}

/** What's due for a refresh now: nothing while you're away or the allowance is low. */
export function due(s: RefreshState): { queue: boolean; pr: boolean } {
  if (!s.watching || budgetLow(s.budget, s.now)) return { queue: false, pr: false };
  return {
    queue: s.now - s.queueAt >= QUEUE_EVERY,
    pr: s.prAt != null && s.now - s.prAt >= (s.waiting ? PR_WAITING_EVERY : PR_EVERY),
  };
}

/** On coming back: refresh what's older than a minute (unless the allowance is low). */
export function dueOnReturn(s: Omit<RefreshState, 'watching' | 'waiting'>): { queue: boolean; pr: boolean } {
  if (budgetLow(s.budget, s.now)) return { queue: false, pr: false };
  return { queue: s.now - s.queueAt >= STALE_ON_RETURN, pr: s.prAt != null && s.now - s.prAt >= STALE_ON_RETURN };
}

const all = (items: ConversationItem[]): Comment[] => items.flatMap((it) => (it.kind === 'thread' ? it.comments : [it.comment]));

/** Checks are running, or a one-click comment (like "@codex review") was posted and its reviewer hasn't replied. */
export function waiting(pr: PrDetail, actions: CommentAction[], me: string): boolean {
  if (pr.state !== 'open') return false;
  if (pr.checks.pending) return true;
  return actions.some((a) => {
    const { asked, reply } = askAndReply(pr.conversation, a, me);
    return !!a.reviewer && !!asked && !(reply && Date.parse(reply.createdAt) >= Date.parse(asked.createdAt));
  });
}

/**
 * For a one-click comment: the last time you posted it, and its reviewer's latest comment. The reviewer's name
 * matches its bot login too ("chatgpt-codex-connector" and "chatgpt-codex-connector[bot]").
 */
export function askAndReply(items: ConversationItem[], a: CommentAction, me: string): { asked: Comment | null; reply: Comment | null } {
  const bare = (s: string) => s.toLowerCase().replace(/\[bot\]$/, '');
  const latest = (match: (c: Comment) => boolean) => all(items).filter(match).sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))[0] ?? null;
  return {
    asked: latest((c) => c.author === me && c.text.trim() === a.comment.trim()),
    reply: a.reviewer ? latest((c) => bare(c.author) === bare(a.reviewer!)) : null,
  };
}

/** Bots by their product name: "Codex", not "chatgpt-codex-connector". */
export const who = (login: string) => (/codex/i.test(login) ? 'Codex' : login.replace(/\[bot\]$/, ''));

/**
 * What arrived on a PR between two loads, in one line: findings and comments by who left them, new commits,
 * and checks that finished. Null when nothing did (or only your own comments).
 */
export function whatArrived(before: PrDetail, after: PrDetail, me: string): string | null {
  const parts: string[] = [];
  const seen = new Set(all(before.conversation).map((c) => c.url + c.createdAt));
  const threadIds = new Set(before.conversation.filter((it) => it.kind === 'thread').map((it) => (it.kind === 'thread' ? it.id : '')));
  const findings = after.conversation.filter((it) => it.kind === 'thread' && !threadIds.has(it.id) && it.severity != null);
  const byWho = new Map<string, number>();
  for (const it of findings) if (it.kind === 'thread') byWho.set(who(it.comments[0]?.author ?? ''), (byWho.get(who(it.comments[0]?.author ?? '')) ?? 0) + 1);
  for (const [w, n] of byWho) parts.push(`${w} left ${plural(n, 'finding')}`);
  const findingComments = new Set(findings.flatMap((it) => (it.kind === 'thread' ? it.comments : [])));
  const fresh = all(after.conversation).filter((c) => !seen.has(c.url + c.createdAt) && c.author !== me && !findingComments.has(c));
  const commenters = [...new Set(fresh.map((c) => who(c.author)))];
  if (commenters.length) parts.push(`${commenters.join(', ')} commented`);
  if (after.headSha !== before.headSha) parts.push(`${after.author} pushed new commits`);
  if (before.checks.pending && !after.checks.pending) parts.push(after.checks.failed ? `checks finished: ${plural(after.checks.failed, 'failing')}` : 'checks passed');
  if (!parts.length) return null;
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

/** On the queue: how many more PRs became your turn since the last load. */
export function newlyYourTurn(before: PrSummary[], after: PrSummary[], isYours: (p: PrSummary) => boolean): number {
  const was = new Set(before.filter(isYours).map((p) => `${p.repo}#${p.number}`));
  return after.filter((p) => isYours(p) && !was.has(`${p.repo}#${p.number}`)).length;
}
