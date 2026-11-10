import type { Draft, MergeMethod, PrDetail, PrSummary, ReviewEvent } from './protocol';
import type { Budget } from './refresh';
import type { DataSource } from './source';

/**
 * One queue for the sidebar and the panel: loads within `ttl` of each other (or at the same moment) share one
 * request to GitHub, instead of each fetching its own. Everything else passes straight through.
 */
export class SharedSource implements DataSource {
  private cache: { at: number; prs: Promise<PrSummary[]> } | null = null;

  constructor(private readonly inner: DataSource, private readonly ttl = 30_000, private readonly now = () => Date.now()) {}

  get scope(): string { return this.inner.scope; }
  get sample(): boolean { return this.inner.sample; }

  listPrs(): Promise<PrSummary[]> {
    if (this.cache && this.now() - this.cache.at < this.ttl) return this.cache.prs;
    const prs = this.inner.listPrs();
    this.cache = { at: this.now(), prs };
    // A failed load isn't kept: the next ask tries again.
    prs.catch(() => { if (this.cache?.prs === prs) this.cache = null; });
    return prs;
  }

  invalidate(): void { this.cache = null; }
  budget(): Budget | null { return this.inner.budget?.() ?? null; }
  viewer(): Promise<string> { return this.inner.viewer(); }
  getPr(repo: string, number: number, sinceSha: string | null): Promise<PrDetail> { return this.inner.getPr(repo, number, sinceSha); }
  setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> { return this.inner.setViewed(pr, path, viewed); }
  approve(pr: PrDetail): Promise<void> { return this.inner.approve(pr); }
  merge(pr: PrDetail, method: MergeMethod): Promise<void> { return this.inner.merge(pr, method); }
  updateBranch(pr: PrDetail): Promise<void> { return this.inner.updateBranch(pr); }
  comment(pr: PrDetail, body: string): Promise<void> { return this.inner.comment(pr, body); }
  submitReview(pr: PrDetail, event: ReviewEvent, body: string, drafts: Draft[]): Promise<void> { return this.inner.submitReview(pr, event, body, drafts); }
  commentNow(pr: PrDetail, draft: Draft): Promise<void> { return this.inner.commentNow(pr, draft); }
}
