import { describe, expect, it } from 'vitest';
import { GitHubSource } from '../src/github';
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

  it('posts a single comment as its own review, and refuses while a review is in progress', async () => {
    const free = fake(null);
    await free.src.commentNow(pr, reply);
    expect(free.calls).toEqual(['reviews(states: PENDING', 'addPullRequestReview', 'addPullRequestReviewThreadReply', 'submitPullRequestReview', 'resolveReviewThread']);
    await expect(fake('me').src.commentNow(pr, line)).rejects.toThrow(/review in progress/);
  });
});
