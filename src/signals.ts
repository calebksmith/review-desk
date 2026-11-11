import type { PrSummary } from './protocol';
import { childrenOf } from './stacks';
import type { Tone } from './status';

// What makes one review more urgent than another, beyond whose turn it is: releases, PRs waiting on it,
// how long someone has waited, and what Codex found. Each signal can be shown as a reason on the row.

export const DEFAULT_BLOCKER_LABELS = ['release-blocker', 'hotfix', 'blocker', 'urgent'];
const DAY = 24 * 60 * 60_000;

/** PR numbers a description says it waits on: "Depends on #12", "Blocked by #12, #13", "After #12". */
export function parseDependsOn(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(/\b(?:depends on|blocked by|after|requires)\s+((?:#\d+[\s,and&]*)+)/gi)) {
    for (const n of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out];
}

/**
 * The Linear issue a PR belongs to: a linear.app link in the description, a branch named like Linear makes
 * them ("dana/eng-398-node-22"), or a title that starts with the key ("[ENG-398] …", "ENG-398: …").
 */
export function parseLinear(p: { title: string; headRef: string; body: string }): { key: string; url: string | null } | null {
  const link = /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)[^\s)"]*/.exec(p.body);
  if (link) return { key: link[1]!.toUpperCase(), url: link[0] };
  const branch = /(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?=-|$)/.exec(p.headRef);
  if (branch) return { key: `${branch[1]!.toUpperCase()}-${branch[2]}`, url: null };
  const title = /^\[?([A-Z][A-Z0-9]{1,9}-\d{1,6})\]?[:\s]/.exec(p.title);
  return title ? { key: title[1]!, url: null } : null;
}

export interface Signals {
  /** Open PRs waiting on this one: stacked on it (at any depth) or saying they depend on it. */
  blocks: number;
  /** A blocker label, or a hotfix branch. */
  releaseBlocker: boolean;
  release: { title: string; dueOn: string | null; soon: boolean } | null;
  /** When the wait started: when you were asked to review, or when it was opened. */
  waitingSince: string;
}

export function signals(p: PrSummary, queue: readonly PrSummary[], blockerLabels: readonly string[], now = Date.now()): Signals {
  const above = new Set<string>();
  const walk = (pr: PrSummary) => { for (const c of childrenOf(pr, queue)) if (!above.has(`${c.number}`)) { above.add(`${c.number}`); walk(c); } };
  walk(p);
  for (const q of queue) if (q.state === 'open' && q.repo === p.repo && q.dependsOn.includes(p.number)) above.add(`${q.number}`);
  const labels = new Set(blockerLabels.map((l) => l.toLowerCase()));
  const releaseBranch = /^release[/-]/.test(p.baseRef) ? { title: p.baseRef, dueOn: null } : null;
  const ms = p.milestone ?? releaseBranch;
  return {
    blocks: above.size,
    releaseBlocker: p.labels.some((l) => labels.has(l.toLowerCase())) || /^hotfix[/-]/.test(p.headRef),
    release: ms ? { ...ms, soon: !!ms.dueOn && Date.parse(ms.dueOn) - now <= 2 * DAY } : null,
    waitingSince: p.requestedAt ?? p.createdAt,
  };
}

/** 0: a release blocker or a release due within two days; 1: others wait on it; 2: in a release; 3: the rest. */
export function tier(s: Signals): number {
  if (s.releaseBlocker || s.release?.soon) return 0;
  if (s.blocks) return 1;
  if (s.release) return 2;
  return 3;
}

/** Up to three short reasons for a row, most important first: what makes it urgent, then how long it's waited. */
export function reasons(p: PrSummary, s: Signals, now = Date.now()): { text: string; tone: Tone; title?: string }[] {
  const out: { text: string; tone: Tone; title?: string }[] = [];
  if (s.releaseBlocker) out.push({ text: 'Release blocker', tone: 'bad' });
  if (s.release) {
    // A milestone is named on the row already; the reason only says when it's due.
    const fromMilestone = p.milestone?.title === s.release.title;
    const when = s.release.dueOn ? due(s.release.dueOn, now) : null;
    const text = fromMilestone ? (when ? (when === 'overdue' ? 'Overdue' : when.startsWith('due') ? `D${when.slice(1)}` : `Due ${when}`) : null)
      : when ? `${s.release.title.length > 18 ? 'Release' : s.release.title} · ${when}` : s.release.title;
    if (text) out.push({ text, tone: s.release.soon ? 'warn' : 'muted', title: s.release.title });
  }
  if (s.blocks) out.push({ text: `Blocks ${s.blocks}`, tone: 'run', title: `${s.blocks} open PR${s.blocks === 1 ? ' is' : 's are'} waiting on this one` });
  if (p.findingCounts.p0 || p.findingCounts.p1) out.push({ text: `${p.findingCounts.p0 ? `${p.findingCounts.p0} P0` : `${p.findingCounts.p1} P1`} open`, tone: p.findingCounts.p0 ? 'bad' : 'warn' });
  const waited = now - Date.parse(s.waitingSince);
  if (waited >= DAY) out.push({ text: `Waiting ${Math.floor(waited / DAY)}d`, tone: 'muted', title: `Waiting since ${new Date(s.waitingSince).toLocaleString()}` });
  return out.slice(0, 3);
}

function due(iso: string, now: number): string {
  const days = Math.ceil((Date.parse(iso) - now) / DAY);
  if (days < 0) return 'overdue';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** What the queue's milestone filter shows when you pick "No milestone". Titles can't be empty, so it can't clash. */
export const NO_MILESTONE = '';

/**
 * The milestones in the queue, for its filter: soonest due first, then those with no due date, by title. Repos that
 * share a milestone title (one release across repos) count as one. `count` is how many PRs each holds.
 */
export function milestones(queue: readonly PrSummary[]): { title: string; dueOn: string | null; count: number }[] {
  const by = new Map<string, { title: string; dueOn: string | null; count: number }>();
  for (const p of queue) {
    if (!p.milestone) continue;
    const m = by.get(p.milestone.title) ?? { title: p.milestone.title, dueOn: p.milestone.dueOn, count: 0 };
    m.count++;
    if (p.milestone.dueOn && (!m.dueOn || p.milestone.dueOn < m.dueOn)) m.dueOn = p.milestone.dueOn;
    by.set(m.title, m);
  }
  const at = (d: string | null) => (d ? Date.parse(d) : Infinity);
  return [...by.values()].sort((a, b) => at(a.dueOn) - at(b.dueOn) || a.title.localeCompare(b.title));
}

/** Whether a PR is in the milestone picked in the filter: null is every PR, NO_MILESTONE those without one. */
export function inMilestone(p: Pick<PrSummary, 'milestone'>, pick: string | null): boolean {
  if (pick === null) return true;
  return pick === NO_MILESTONE ? !p.milestone : p.milestone?.title === pick;
}
