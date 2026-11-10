import { describe, expect, it } from 'vitest';
import { GitHubSource, requestedQuery, toSummary, type RawPr } from '../src/github';
import type { Draft, PrDetail } from '../src/protocol';

/** A GitHubSource whose GraphQL calls are recorded and answered by `reply`. */
function fake(pendingFor: string | null, fail?: string) {
  const calls: string[] = [];
  const src = new GitHubSource('token', { kind: 'repo', repo: 'acme/web' });
  Object.assign(src as object, { login: 'me' });
  (src as unknown as { octokit: { graphql: (q: string, v: Record<string, unknown>) => Promise<unknown> } }).octokit = {
    graphql: async (q: string) => {
      const op = /(addPullRequestReviewThreadReply|addPullRequestReviewThread|addPullRequestReview|submitPullRequestReview|deletePullRequestReview|resolveReviewThread|reviews\(states: PENDING)/.exec(q)?.[1] ?? '?';
      calls.push(op);
      if (fail && op === fail) throw new Error(`${op} failed`);
      if (op === 'reviews(states: PENDING') return { node: { reviews: { nodes: pendingFor ? [{ id: 'R_pending', author: { login: pendingFor } }] : [] } } };
      if (op === 'addPullRequestReview') return { addPullRequestReview: { pullRequestReview: { id: 'R_new' } } };
      return {};
    },
  };
  return { src, calls };
}

const pr = { repo: 'acme/web', number: 1, nodeId: 'PR_1', headSha: 'abc' } as PrDetail;
const line: Draft = { id: 'a', path: 'a.ts', line: 3, side: 'RIGHT', body: 'Rename this', from: 'you' };
const reply: Draft = { id: 'b', path: 'a.ts', line: 3, side: 'RIGHT', body: 'Not an issue: fine', from: 'you', replyTo: 'T_1', resolve: true };

describe('sending reviews to GitHub', () => {
  it('reuses the review you started on github.com instead of starting a second one', async () => {
    const { src, calls } = fake('me');
    await src.submitReview(pr, 'COMMENT', '', [line, reply]);
    expect(calls).toEqual(['reviews(states: PENDING', 'addPullRequestReviewThread', 'addPullRequestReviewThreadReply', 'submitPullRequestReview', 'resolveReviewThread']);
  });

  it('starts a review when there isn’t one, and ignores someone else’s pending review', async () => {
    const { src, calls } = fake('someone-else');
    await src.submitReview(pr, 'APPROVE', 'Looks good', [line]);
    expect(calls).toEqual(['reviews(states: PENDING', 'addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
  });

  it('removes a review it started if sending fails, but never yours', async () => {
    const started = fake(null, 'submitPullRequestReview');
    await expect(started.src.submitReview(pr, 'COMMENT', 'x', [line])).rejects.toThrow('submitPullRequestReview failed');
    expect(started.calls.at(-1)).toBe('deletePullRequestReview');
    const yours = fake('me', 'submitPullRequestReview');
    await expect(yours.src.submitReview(pr, 'COMMENT', 'x', [line])).rejects.toThrow();
    expect(yours.calls).not.toContain('deletePullRequestReview');
  });

  it('says which comments already went into your review when it fails partway, so a retry doesn’t post them twice', async () => {
    const { src } = fake('me', 'addPullRequestReviewThreadReply');
    await expect(src.submitReview(pr, 'COMMENT', '', [line, reply])).rejects.toMatchObject({ added: ['a'] });
  });

  it('posts a single comment as its own review, and refuses while a review is in progress', async () => {
    const free = fake(null);
    await free.src.commentNow(pr, reply);
    expect(free.calls).toEqual(['reviews(states: PENDING', 'addPullRequestReview', 'addPullRequestReviewThreadReply', 'submitPullRequestReview', 'resolveReviewThread']);
    await expect(fake('me').src.commentNow(pr, line)).rejects.toThrow(/review in progress/);
  });

  it('counts a thread it couldn’t resolve instead of failing a review that was sent', async () => {
    const { src, calls } = fake(null, 'resolveReviewThread');
    await expect(src.submitReview(pr, 'COMMENT', '', [reply])).resolves.toEqual({ unresolved: 1 });
    expect(calls).toContain('submitPullRequestReview');
    expect(calls).not.toContain('deletePullRequestReview');
    await expect(fake(null, 'resolveReviewThread').src.commentNow(pr, reply)).resolves.toEqual({ unresolved: 1 });
  });

  it('approves through your pending review, so it doesn’t start a second one', async () => {
    const { src, calls } = fake('me');
    await src.approve(pr);
    expect(calls).toEqual(['reviews(states: PENDING', 'submitPullRequestReview']);
  });
});

const raw = (over: Partial<RawPr> = {}): RawPr => ({
  repository: { nameWithOwner: 'acme/web' }, number: 5, title: 't', url: '', additions: 0, deletions: 0, updatedAt: '2026-11-01T00:00:00Z',
  isDraft: false, state: 'OPEN', headRefOid: 'abc', createdAt: '2026-11-01T00:00:00Z', body: '', milestone: null,
  timelineItems: { nodes: [] }, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team' } }] }, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  reviewThreads: { nodes: [] }, recentThreads: { nodes: [] }, author: { login: 'sam' }, labels: { nodes: [] }, latestReviews: { nodes: [] },
  commits: { nodes: [] }, ...over,
});

describe('reading PRs from GitHub', () => {
  it('downloads a failed job’s log once, however often the PR refreshes', async () => {
    const src = new GitHubSource('token', { kind: 'repo', repo: 'acme/web' });
    let downloads = 0;
    (src as unknown as { octokit: unknown }).octokit = { actions: {
      getJobForWorkflowRun: async () => ({ data: { steps: [{ name: 'Run tests', conclusion: 'failure' }] } }),
      downloadJobLogsForWorkflowRun: async () => { downloads++; return { data: '##[group]Run npm test\n##[endgroup]\nError: boom\n##[error]Process completed with exit code 1.' }; },
    } };
    const first = await src['jobFailure']('acme/web', 7);
    expect(first).toEqual({ failedStep: 'Run tests', excerpt: ['Error: boom'] });
    expect(await src['jobFailure']('acme/web', 7)).toBe(first);
    expect(downloads).toBe(1);
  });

  it('counts a team request as yours when GitHub’s review-requested:@me search found the PR', () => {
    expect(toSummary(raw(), 'me').reviewRequested).toBe(false);
    expect(toSummary(raw(), 'me', true)).toMatchObject({ reviewRequested: true, reviewers: [{ login: 'a team', state: 'requested' }] });
    expect(toSummary(raw({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] } }), 'me').reviewRequested).toBe(true);
  });

  it('marks PRs from a fork', () => {
    expect(toSummary(raw(), 'me').fromFork).toBe(false);
    expect(toSummary(raw({ isCrossRepository: true, headRefName: 'main' }), 'me').fromFork).toBe(true);
  });

  it('asks for team requests in one repo with the same search', async () => {
    const src = new GitHubSource('token', { kind: 'repo', repo: 'acme/web' });
    Object.assign(src as object, { login: 'me' });
    let vars: Record<string, unknown> = {};
    (src as unknown as { octokit: unknown }).octokit = {
      graphql: async (_q: string, v: Record<string, unknown>) => {
        vars = v;
        return { rateLimit: { remaining: 5000, limit: 5000, resetAt: '' }, repository: { open: { nodes: [raw(), raw({ number: 6 })] }, merged: { nodes: [] } }, asked: { nodes: [{ number: 5 }] } };
      },
    };
    const prs = await src.listPrs();
    expect(vars.asked).toBe(requestedQuery('acme/web'));
    expect(prs.map((p) => [p.number, p.reviewRequested])).toEqual([[5, true], [6, false]]);
  });
});
