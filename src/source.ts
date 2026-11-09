import type { MergeMethod, PrDetail, PrSummary } from './protocol';

/** Where review data comes from: GitHub, or the built-in sample PRs. */
export interface DataSource {
  readonly repo: string;
  readonly sample: boolean;
  viewer(): Promise<string>;
  listPrs(): Promise<PrSummary[]>;
  /** sinceSha is the head the reviewer last saw, so the source can diff what changed after it. */
  getPr(number: number, sinceSha: string | null): Promise<PrDetail>;
  setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void>;
  approve(pr: PrDetail): Promise<void>;
  merge(pr: PrDetail, method: MergeMethod): Promise<void>;
  /** Brings the base branch into the PR branch, like GitHub's Update branch button. */
  updateBranch(pr: PrDetail): Promise<void>;
}

/** Small key-value store; VS Code's workspaceState in the extension, a Map in tests. */
export interface Store {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): PromiseLike<void> | void;
}
