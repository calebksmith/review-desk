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
  /**
   * Sends a review: the verdict, a summary, and the held-back comments. Replies and resolves go with it.
   * Throws only if nothing was sent; threads it then couldn't resolve are counted in the result. An error may
   * carry `added`: ids of drafts that are already in the reviewer's pending review and mustn't be sent again.
   */
  submitReview(pr: PrDetail, event: ReviewEvent, body: string, drafts: Draft[]): Promise<Sent>;
  /** Resolves a thread right away, like GitHub's Resolve conversation. */
  resolveThread(pr: PrDetail, threadId: string): Promise<void>;
  /** Posts one line comment or reply right away, outside a review. */
  commentNow(pr: PrDetail, draft: Draft): Promise<Sent>;
  /** GitHub's hourly allowance as of the last queue load; null when unknown (samples). */
  budget?(): Budget | null;
  /** Drops a cached queue so the next load fetches (after an action, or the Refresh button). */
  invalidate?(): void;
}

/** What happened after a review or comment was sent: threads a reply asked to resolve that GitHub didn't. */
export interface Sent { unresolved: number }

/** Small key-value store; VS Code's workspaceState in the extension, a Map in tests. */
export interface Store {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): PromiseLike<void> | void;
}
