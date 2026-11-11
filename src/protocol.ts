// Messages and data shared by the extension host and the webview.

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale';

export interface ChecksTally { passed: number; failed: number; pending: number; total: number }

export interface PrSummary {
  /** owner/name. PR numbers only mean something within their repo. */
  repo: string;
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
  /** The commit that review was on, so a later push means "re-review". */
  myReviewSha: string | null;
  headRef: string;
  /** Its branch is in a fork, so it can't be the base of another PR here, whatever it's called. */
  fromFork: boolean;
  /** The branch it merges into. Another open PR's branch when the PR is stacked on it. */
  baseRef: string;
  /** Opened by the signed-in reviewer, who can't approve it. */
  mine: boolean;
  /** GitHub's review decision. Null when the repo doesn't require reviews. */
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  /** Each reviewer's latest review, and who's been asked but hasn't reviewed yet. */
  reviewers: Reviewer[];
  /** The signed-in reviewer has been asked to review it. */
  reviewRequested: boolean;
  createdAt: string;
  /** When the signed-in reviewer was last asked to review it. */
  requestedAt: string | null;
  milestone: { title: string; dueOn: string | null } | null;
  /** PR numbers (same repo) its description says it depends on. */
  dependsOn: number[];
  /** The Linear issue it belongs to, when it says. */
  linear: { key: string; url: string | null } | null;
  /** Unresolved findings marked P0 and P1. */
  findingCounts: { p0: number; p1: number };
  checks: ChecksTally;
  /** False when the PR conflicts with its base. Null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's merge state: 'behind' means the base has moved on since the branch was cut. */
  mergeState: MergeState;
  unresolvedThreads: number;
}

/** `no_issues`: a review agent (Codex) that found nothing and so left a comment, not a GitHub review. */
export interface Reviewer { login: string; state: 'approved' | 'changes_requested' | 'commented' | 'requested' | 'no_issues' }

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
  /** Branch protection requires it to pass before merging. */
  required?: boolean;
  /** How long it ran. */
  seconds?: number | null;
}

export interface SinceLastLook {
  /** Since the reviewer last opened the PR, or since their last review (a re-review). */
  kind?: 'look' | 'review';
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
  /** The comment as written (Markdown), for prompts. */
  text: string;
  url: string;
  /** Posted by someone else after the reviewer last opened the PR. */
  isNew: boolean;
}

export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

/** What people said on a PR: comments, reviews, and threads on lines of code. */
export type ConversationItem =
  | { kind: 'comment'; comment: Comment }
  | { kind: 'review'; verdict: ReviewVerdict; comment: Comment }
  | { kind: 'thread'; id: string; path: string; line: number | null; resolved: boolean; outdated: boolean; comments: Comment[];
      /** P0–P3 from the first comment (Codex marks its findings this way); null when unmarked. */
      severity: number | null };

export interface PrDetail extends PrSummary {
  nodeId: string;
  /** The description as written (Markdown). */
  body: string;
  /** The description as GitHub renders it. */
  bodyHtml: string;
  /** Oldest first, as on GitHub. */
  conversation: ConversationItem[];
  /** Whether the reviewer has opened this PR before; set by the controller. */
  seenBefore?: boolean;
  /** Merge methods the repo allows, the default first. */
  mergeMethods: MergeMethod[];
  files: FileDiff[];
  checkRuns: CheckRun[];
  /** A review of yours started elsewhere (github.com) and not sent yet; its comments go with your next review. */
  pendingReview?: { comments: number } | null;
  /** Dependabot's compatibility score: the share of other repos where this update passed CI. */
  compatibility?: number | null;
  /** Changes pushed since the reviewer last opened this PR, when there are any. */
  sinceLastLook: SinceLastLook | null;
}

/** How a review ends: GitHub's three verdicts. */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * A comment held back for the reviewer's review: a new comment on a line of the diff, or a reply to an
 * existing thread (which can also resolve it). Review Desk keeps these until the review is sent.
 */
export interface Draft {
  id: string;
  path: string;
  /** The line it's on: the new file's line for added or unchanged lines, the old file's for removed ones. */
  line: number | null;
  side: 'RIGHT' | 'LEFT';
  /** First line of a multi-line comment. */
  startLine?: number | null;
  /** A reply to this thread instead of a new comment. */
  replyTo?: string;
  /** Resolve that thread when the review is sent. */
  resolve?: boolean;
  body: string;
  /** Written by the reviewer, or suggested by their agent and not kept yet. */
  from: 'you' | 'agent';
  /**
   * Already in your pending review on GitHub: a send failed after this reply was added. It isn't posted again;
   * it's kept only because its thread is still to be resolved when the review goes through.
   */
  sent?: boolean;
  severity?: number | null;
}

/** A comment the reviewer can post in one click, like "@codex review". From the reviewDesk.commentActions setting. */
export interface CommentAction {
  label: string;
  comment: string;
  /** The account that answers it, such as chatgpt-codex-connector. Its latest reply shows beside the button. */
  reviewer?: string;
}

/** A PR's identity across repos: "owner/name#123". */
export const prKey = (p: { repo: string; number: number }): string => `${p.repo}#${p.number}`;

export function parseKey(key: string): { repo: string; number: number } | null {
  const m = /^(.+)#(\d+)$/.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/** What you decided for a finding on your PR (or your agent's), for the agent session that resolves them. */
export type Decision = 'fix' | 'skip' | 'discuss';

export interface HostState {
  /** What the queue covers, for the header: a repo, or "Everything involving you". */
  scope: string;
  user: string;
  sample: boolean;
  view: 'queue' | 'pr';
  queue: PrSummary[];
  pr: PrDetail | null;
  loading: boolean;
  busy: 'approve' | 'merge' | 'update' | 'bulk' | 'comment' | 'review' | 'resolve' | 'draft' | null;
  /** Progress while merging Dependabot updates in one go. */
  bulk: { done: number; total: number } | null;
  /** What the last bulk merge did, until the reviewer dismisses it. */
  notice: string | null;
  actions: CommentAction[];
  /** Labels that mark a PR as blocking a release (reviewDesk.blockerLabels). */
  blockerLabels: string[];
  /** The open PR's held-back comments, sent with the review. */
  drafts: Draft[];
  /**
   * On your PR or your agent's: your call on each finding (Fix, Not an issue, Discuss), and when each went to
   * your agent in a Resolve with agent session. Kept per PR, like drafts.
   */
  triage: Triage;
  /** When what's on screen (the queue, or the open PR) last loaded from GitHub. */
  updatedAt: string | null;
  error: string | null;
}

/** `sentSha`: the PR's head when findings last went to your agent, so new commits after it can be pointed out. */
export interface Triage { decisions: Record<string, Decision>; sent: Record<string, string>; sentSha?: string }

export type ToWebview =
  | { type: 'state'; state: HostState }
  | { type: 'toast'; text: string }
  /** A comment or review that failed to send, handed back so the panel can put the text back in its box. */
  | { type: 'unsent'; msg: Extract<FromWebview, { type: 'comment' | 'submitReview' | 'commentNow' }> };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openPr'; key: string }
  | { type: 'back' }
  | { type: 'setViewed'; path: string; viewed: boolean }
  | { type: 'approve' }
  | { type: 'merge'; method: MergeMethod }
  | { type: 'updateBranch' }
  | { type: 'openFile'; path: string; line: number | null }
  | { type: 'openExternal'; url: string }
  | { type: 'mergeDependabot' }
  | { type: 'fixWithAgent'; check: string }
  | { type: 'fixThread'; id: string }
  | { type: 'decide'; id: string; decision: Decision | null }
  /** Sends the findings not yet with your agent (all of them when every one is); `again` sends every one. */
  | { type: 'resolveWithAgent'; again?: boolean }
  | { type: 'fixConflicts' }
  | { type: 'comment'; body: string }
  | { type: 'closeDependabot' }
  | { type: 'switchRepository' }
  | { type: 'submitReview'; event: ReviewEvent; body: string }
  | { type: 'addDraft'; draft: Omit<Draft, 'id' | 'from'> }
  | { type: 'editDraft'; id: string; body: string }
  | { type: 'keepDraft'; id: string }
  | { type: 'deleteDraft'; id: string }
  | { type: 'commentNow'; draft: Omit<Draft, 'id' | 'from'> }
  | { type: 'resolveThread'; id: string }
  | { type: 'setDraft'; draft: boolean }
  | { type: 'reviewWithAgent' }
  | { type: 'dismissNotice' };
