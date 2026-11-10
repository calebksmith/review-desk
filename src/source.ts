import type { Draft, MergeMethod, PrDetail, PrSummary, ReviewEvent } from './protocol';
import type { Budget } from './refresh';

/** Where review data comes from: GitHub, or the built-in sample PRs. */
export interface DataSource {
  /** What the queue covers, for the header: a repo, or "Everything involving you". */
  readonly scope: string;
  readonly sample: boolean;
  viewer(): Promise<string>;
  listPrs(): Promise<PrSummary[]>;
  /** sinceSha is the head the reviewer last saw, so the source can diff what changed after it. */
  getPr(repo: string, number: number, sinceSha: string | null): Promise<PrDetail>;
  setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void>;
  approve(pr: PrDetail): Promise<void>;
  merge(pr: PrDetail, method: MergeMethod): Promise<void>;
  /** Brings the base branch into the PR branch, like GitHub's Update branch button. */
  updateBranch(pr: PrDetail): Promise<void>;
  /** Posts a comment on the PR's conversation. */
  comment(pr: PrDetail, body: string): Promise<void>;
  /** Sends a review: the verdict, a summary, and the held-back comments. Replies and resolves go with it. */
  submitReview(pr: PrDetail, event: ReviewEvent, body: string, drafts: Draft[]): Promise<void>;
  /** Posts one line comment or reply right away, outside a review. */
  commentNow(pr: PrDetail, draft: Draft): Promise<void>;
  /** GitHub's hourly allowance as of the last queue load; null when unknown (samples). */
  budget?(): Budget | null;
  /** Drops a cached queue so the next load fetches (after an action, or the Refresh button). */
  invalidate?(): void;
}

/** Small key-value store; VS Code's workspaceState in the extension, a Map in tests. */
export interface Store {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): PromiseLike<void> | void;
}
