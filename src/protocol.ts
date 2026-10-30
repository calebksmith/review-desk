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
}

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
}

export interface SinceLastLook {
  fromSha: string;
  toSha: string;
  commits: number;
  files: FileDiff[];
}

export interface PrDetail extends PrSummary {
  nodeId: string;
  body: string;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeMethod: 'squash' | 'merge' | 'rebase';
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
  busy: 'approve' | 'merge' | null;
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
  | { type: 'merge' }
  | { type: 'openFile'; path: string; line: number | null }
  | { type: 'openExternal'; url: string };
