import { parsePatch } from './patch';
import type { CheckRun, Comment, ConversationItem, FileDiff, PrSummary, Reviewer } from './protocol';

// Helpers for the sample PRs. Content is made up; shapes match GitHub.

export const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const file = (path: string, patch: string, viewed: FileDiff['viewed'] = 'unviewed'): FileDiff => {
  const lines = parsePatch(patch);
  return { path, status: 'modified', viewed, lines,
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length };
};

export const pass = (name: string, app: string, summary: string | null = null): CheckRun => ({ name, app, status: 'completed', conclusion: 'success', url: 'https://github.com', summary, failedStep: null, excerpt: null });
export const fail = (name: string, app: string, failedStep: string, excerpt: string[]): CheckRun => ({ name, app, status: 'completed', conclusion: 'failure', url: 'https://github.com', summary: null, failedStep, excerpt });
export const running = (name: string, app: string, summary: string | null = null): CheckRun => ({ name, app, status: 'in_progress', conclusion: null, url: 'https://github.com', summary, failedStep: null, excerpt: null });
export const say = (author: string, min: number, html: string): Comment => ({ author, createdAt: ago(min), html, text: html.replace(/<[^>]+>/g, ''), url: 'https://github.com', isNew: false });

/** What a seed spells out; the source works out the rest (branches, whose it is, the review decision). */
export type SeedSummary = Omit<PrSummary, 'repo' | 'headRef' | 'baseRef' | 'mine' | 'reviewDecision' | 'reviewers' | 'reviewRequested' | 'myReviewSha'> & { myReviewSha?: string | null };

export interface SamplePr {
  /** owner/name; the set's repo when not given. */
  repo?: string;
  summary: SeedSummary;
  files: FileDiff[];
  checkRuns: CheckRun[];
  body: string;
  bodyHtml: string;
  conversation: ConversationItem[];
  headRef: string;
  /** The branch it merges into; main unless it's stacked. */
  base?: string;
  /** Other people's reviews and review requests. The viewer's own review is summary.myReview. */
  reviewers?: Reviewer[];
}

/** GitHub's review decision: null without review rules, otherwise changes requested, approved, or still needed. */
export function decide(reviewers: Reviewer[], required: number, author: string): PrSummary['reviewDecision'] {
  if (!required) return null;
  if (reviewers.some((r) => r.state === 'changes_requested')) return 'changes_requested';
  return reviewers.filter((r) => r.state === 'approved' && r.login !== author).length >= required ? 'approved' : 'review_required';
}

/** Fills in each PR's size from its files. */
export function sized(prs: SamplePr[]): SamplePr[] {
  for (const p of prs) {
    p.summary.additions = p.files.reduce((n, f) => n + f.additions, 0);
    p.summary.deletions = p.files.reduce((n, f) => n + f.deletions, 0);
  }
  return prs;
}
