// Messages and data shared by the extension host and the webview.

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale';

export interface ChecksTally { passed: number; failed: number; pending: number; total: number }

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  url: string;
  additions: number;
  deletions: number;
  updatedAt: string;
  headSha: string;
  isDraft: boolean;
  state: 'open' | 'merged';
  labels: string[];
  /** The signed-in reviewer's latest review on this PR. */
  myReview: 'approved' | 'changes_requested' | 'commented' | null;
  checks: ChecksTally;
  /** False when the PR conflicts with its base. Null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's merge state: 'behind' means the base has moved on since the branch was cut. */
  mergeState: MergeState;
  unresolvedThreads: number;
}

export type MergeState = 'clean' | 'behind' | 'blocked' | 'dirty' | 'unstable' | 'draft' | 'unknown';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type ViewedState = 'viewed' | 'unviewed' | 'changed';

export type DiffLine =
  | { kind: 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null; text: string }
  | { kind: 'gap'; hidden: number | null };

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  viewed: ViewedState;
  /** Null when GitHub sends no patch (binary or too large). */
  lines: DiffLine[] | null;
}

export interface CheckRun {
  name: string;
  app: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: CheckConclusion | null;
  url: string | null;
  summary: string | null;
  /** The step that failed, for a GitHub Actions job. */
  failedStep: string | null;
  /** The error lines from the failed step's log. */
  excerpt: string[] | null;
}

export interface SinceLastLook {
  fromSha: string;
  toSha: string;
  commits: number;
  files: FileDiff[];
}

/** One comment, with its body as GitHub renders it. The webview sanitizes the HTML before showing it. */
export interface Comment {
  author: string;
  createdAt: string;
  html: string;
  url: string;
  /** Posted by someone else after the reviewer last opened the PR. */
  isNew: boolean;
}

export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

/** What people said on a PR: comments, reviews, and threads on lines of code. */
export type ConversationItem =
  | { kind: 'comment'; comment: Comment }
  | { kind: 'review'; verdict: ReviewVerdict; comment: Comment }
  | { kind: 'thread'; path: string; line: number | null; resolved: boolean; outdated: boolean; comments: Comment[] };

export interface PrDetail extends PrSummary {
  nodeId: string;
  /** The description as written (Markdown). */
  body: string;
  /** The description as GitHub renders it. */
  bodyHtml: string;
  /** Oldest first, as on GitHub. */
  conversation: ConversationItem[];
  headRef: string;
  baseRef: string;
  /** Merge methods the repo allows, the default first. */
  mergeMethods: MergeMethod[];
  files: FileDiff[];
  checkRuns: CheckRun[];
  /** Changes pushed since the reviewer last opened this PR, when there are any. */
  sinceLastLook: SinceLastLook | null;
}

export interface HostState {
  repo: string;
  user: string;
  sample: boolean;
  view: 'queue' | 'pr';
  queue: PrSummary[];
  pr: PrDetail | null;
  loading: boolean;
  busy: 'approve' | 'merge' | 'update' | 'bulk' | null;
  /** Progress while merging Dependabot updates in one go. */
  bulk: { done: number; total: number } | null;
  /** What the last bulk merge did, until the reviewer dismisses it. */
  notice: string | null;
  error: string | null;
}

export type ToWebview =
  | { type: 'state'; state: HostState }
  | { type: 'toast'; text: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openPr'; number: number }
  | { type: 'back' }
  | { type: 'setViewed'; path: string; viewed: boolean }
  | { type: 'approve' }
  | { type: 'merge'; method: MergeMethod }
  | { type: 'updateBranch' }
  | { type: 'openFile'; path: string; line: number | null }
  | { type: 'openExternal'; url: string }
  | { type: 'mergeDependabot' }
  | { type: 'fixWithAgent'; check: string }
  | { type: 'dismissNotice' };
