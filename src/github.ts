import { Octokit } from '@octokit/rest';
import { COMMENT_FIELDS, toConversation, type RawComment, type RawReview, type RawThread } from './conversation';
import { logExcerpt } from './logs';
import { parsePatch } from './patch';
import type { CheckConclusion, CheckRun, ChecksTally, Draft, FileDiff, MergeMethod, MergeState, PrDetail, PrSummary, ReviewEvent, Reviewer, ViewedState } from './protocol';
import { combine, scopeLabel, searchQueries, type Scope } from './scope';
import type { DataSource } from './source';

const PR_FIELDS = `
  number title url additions deletions updatedAt isDraft state headRefOid mergeable mergeStateStatus
  repository { nameWithOwner }
  headRefName baseRefName reviewDecision
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  author { login }
  labels(first: 10) { nodes { name } }
  latestReviews(first: 20) { nodes { author { login } state commit { oid } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { status conclusion }
    ... on StatusContext { state }
  } } } } } }
`;

interface RawPr {
  repository: { nameWithOwner: string };
  number: number; title: string; url: string; additions: number; deletions: number; updatedAt: string;
  isDraft: boolean; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string;
  headRefName: string; baseRefName: string; reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; mergeStateStatus: string;
  reviewThreads: { nodes: { isResolved: boolean }[] };
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  latestReviews: { nodes: { author: { login: string } | null; state: string; commit: { oid: string } | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}
type RawContext =
  | { __typename: 'CheckRun'; status: string; conclusion: string | null }
  | { __typename: 'StatusContext'; state: string };

/** owner and repo for Octokit's REST calls, from "owner/name". */
function at(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Repository should look like owner/name, not "${repo}"`);
  return { owner, repo: name };
}

const REPO_PRS = `
  open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
  merged: pullRequests(states: MERGED, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`;

export class GitHubSource implements DataSource {
  readonly sample = false;
  readonly scope: string;
  private readonly octokit: Octokit;
  private login: string | null = null;

  constructor(token: string, private readonly what: Scope) {
    this.octokit = new Octokit({ auth: token, userAgent: 'review-desk' });
    for (const r of what.kind === 'repo' ? [what.repo] : what.full) at(r);
    this.scope = scopeLabel(what);
  }

  async viewer(): Promise<string> {
    if (!this.login) this.login = (await this.octokit.users.getAuthenticated()).data.login;
    return this.login;
  }

  /** One repo's PRs, or everything involving the reviewer across GitHub plus the repos they want in full. */
  async listPrs(): Promise<PrSummary[]> {
    const me = await this.viewer();
    if (this.what.kind === 'repo') return this.repoPrs(this.what.repo, me);
    const q = searchQueries(new Date(Date.now() - 7 * 24 * 60 * 60_000));
    const found = await this.octokit.graphql<Record<string, { nodes: (RawPr | Record<string, never>)[] }>>(
      `query($a: String!, $b: String!, $c: String!, $m: String!) {
        a: search(query: $a, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        b: search(query: $b, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        c: search(query: $c, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        m: search(query: $m, type: ISSUE, first: 20) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
      }`,
      { a: q.open[0], b: q.open[1], c: q.open[2], m: q.merged },
    );
    const searched = Object.values(found).flatMap((r) => r.nodes.filter((n): n is RawPr => 'number' in n)).map((p) => toSummary(p, me));
    const full = await Promise.all(this.what.full.map((r) => this.repoPrs(r, me)));
    return combine([searched, ...full]);
  }

  private async repoPrs(repo: string, me: string): Promise<PrSummary[]> {
    const { owner, repo: name } = at(repo);
    const data = await this.octokit.graphql<{ repository: { open: { nodes: RawPr[] }; merged: { nodes: RawPr[] } } }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${REPO_PRS} } }`,
      { owner, name },
    );
    return [...data.repository.open.nodes, ...data.repository.merged.nodes].map((p) => toSummary(p, me));
  }

  async getPr(repo: string, number: number, sinceSha: string | null): Promise<PrDetail> {
    const me = await this.viewer();
    const { owner, repo: name } = at(repo);
    const data = await this.octokit.graphql<{ repository: { squashMergeAllowed: boolean; mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean; pullRequest: RawPr & {
      id: string; body: string; bodyHTML: string;
      files: { nodes: { path: string; viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED' }[] };
      comments: { nodes: RawComment[] };
      reviews: { nodes: RawReview[] };
      threads: { nodes: RawThread[] };
    } } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
        squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
        pullRequest(number: $number) { ${PR_FIELDS} id body bodyHTML
          files(first: 100) { nodes { path viewerViewedState } }
          comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
          reviews(last: 50) { nodes { author { login } state submittedAt body bodyHTML url } }
          threads: reviewThreads(first: 50) { nodes { id isResolved isOutdated path line originalLine comments(first: 30) { nodes { ${COMMENT_FIELDS} } } } } }
      } }`,
      { owner, name, number },
    );
    const raw = data.repository.pullRequest;
    const viewed = new Map(raw.files.nodes.map((f) => [f.path, toViewed(f.viewerViewedState)]));

    const files = (await this.octokit.paginate(this.octokit.pulls.listFiles, { owner, repo: name, pull_number: number, per_page: 100 }))
      .map((f): FileDiff => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        viewed: viewed.get(f.filename) ?? 'unviewed',
        lines: f.patch ? parsePatch(f.patch) : null,
      }));

    const [runs, statuses] = await Promise.all([
      this.octokit.paginate(this.octokit.checks.listForRef, { owner, repo: name, ref: raw.headRefOid, per_page: 100 }),
      this.octokit.repos.getCombinedStatusForRef({ owner, repo: name, ref: raw.headRefOid, per_page: 100 }),
    ]);
    const checkRuns = await Promise.all(runs.map(async (r): Promise<CheckRun> => {
      const run: CheckRun = {
        name: r.name,
        app: r.app?.name ?? '',
        status: r.status,
        conclusion: r.conclusion as CheckConclusion | null,
        url: r.html_url ?? null,
        summary: r.output?.summary ?? null,
        failedStep: null,
        excerpt: null,
      };
      // A failed GitHub Actions job says only "exit code 1". Name the step and show its error lines.
      return r.app?.slug === 'github-actions' && isFailure(run.conclusion) ? { ...run, ...(await this.jobFailure(repo, r.id)) } : run;
    }));
    // Older integrations (Vercel, for one) report commit statuses instead of check runs.
    for (const st of statuses.data.statuses) {
      checkRuns.push({
        name: st.context,
        app: 'Commit status',
        status: st.state === 'pending' ? 'pending' : 'completed',
        conclusion: st.state === 'success' ? 'success' : st.state === 'pending' ? null : 'failure',
        url: st.target_url ?? null,
        summary: st.description ?? null,
        failedStep: null,
        excerpt: null,
      });
    }

    let sinceLastLook: PrDetail['sinceLastLook'] = null;
    if (sinceSha && sinceSha !== raw.headRefOid) {
      try {
        const cmp = await this.octokit.repos.compareCommitsWithBasehead({ owner, repo: name, basehead: `${sinceSha}...${raw.headRefOid}` });
        sinceLastLook = {
          fromSha: sinceSha,
          toSha: raw.headRefOid,
          commits: cmp.data.ahead_by,
          files: (cmp.data.files ?? []).map((f) => ({
            path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
            viewed: viewed.get(f.filename) ?? 'unviewed', lines: f.patch ? parsePatch(f.patch) : null,
          })),
        };
      } catch {
        // The old head is gone after a force-push; GitHub's "changed" viewed state still flags the files.
      }
    }

    return {
      ...toSummary(raw, me),
      nodeId: raw.id,
      body: raw.body,
      bodyHtml: raw.bodyHTML,
      conversation: toConversation(raw.comments.nodes, raw.reviews.nodes, raw.threads.nodes),
      mergeMethods: mergeMethods(data.repository),
      files,
      checkRuns,
      sinceLastLook,
    };
  }

  /** The failed step of an Actions job and the error lines from its log. Logs can expire; then it's just the step. */
  private async jobFailure(repo: string, jobId: number): Promise<Pick<CheckRun, 'failedStep' | 'excerpt'>> {
    let failedStep: string | null = null;
    try {
      const job = await this.octokit.actions.getJobForWorkflowRun({ ...at(repo), job_id: jobId });
      failedStep = job.data.steps?.find((st) => st.conclusion === 'failure')?.name ?? null;
      const log = await this.octokit.actions.downloadJobLogsForWorkflowRun({ ...at(repo), job_id: jobId });
      return { failedStep, excerpt: typeof log.data === 'string' ? logExcerpt(log.data) : null };
    } catch {
      return { failedStep, excerpt: null };
    }
  }

  async setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await this.octokit.graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: pr.nodeId, path });
  }

  async approve(pr: PrDetail): Promise<void> {
    await this.octokit.pulls.createReview({ ...at(pr.repo), pull_number: pr.number, commit_id: pr.headSha, event: 'APPROVE' });
  }

  async merge(pr: PrDetail, method: MergeMethod): Promise<void> {
    await this.octokit.pulls.merge({ ...at(pr.repo), pull_number: pr.number, sha: pr.headSha, merge_method: method });
  }

  async comment(pr: PrDetail, body: string): Promise<void> {
    await this.octokit.issues.createComment({ ...at(pr.repo), issue_number: pr.number, body });
  }

  async submitReview(pr: PrDetail, event: ReviewEvent, body: string, drafts: Draft[]): Promise<void> {
    const lines = drafts.filter((d) => !d.replyTo && d.line != null);
    await this.octokit.pulls.createReview({
      ...at(pr.repo), pull_number: pr.number, commit_id: pr.headSha, event, body: body || undefined,
      comments: lines.map((d) => ({ path: d.path, line: d.line!, side: d.side, body: d.body, ...(d.startLine && d.startLine !== d.line ? { start_line: d.startLine, start_side: d.side } : {}) })),
    });
    // GitHub's review call can't hold replies to existing threads; they follow right after, then any resolves.
    for (const d of drafts.filter((x) => x.replyTo)) {
      await this.octokit.graphql('mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { clientMutationId } }', { id: d.replyTo, body: d.body });
      if (d.resolve) await this.octokit.graphql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }', { id: d.replyTo });
    }
  }

  async commentNow(pr: PrDetail, d: Draft): Promise<void> {
    if (d.replyTo) {
      await this.octokit.graphql('mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { clientMutationId } }', { id: d.replyTo, body: d.body });
      if (d.resolve) await this.octokit.graphql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }', { id: d.replyTo });
      return;
    }
    await this.octokit.pulls.createReviewComment({
      ...at(pr.repo), pull_number: pr.number, commit_id: pr.headSha, path: d.path, line: d.line!, side: d.side, body: d.body,
      ...(d.startLine && d.startLine !== d.line ? { start_line: d.startLine, start_side: d.side } : {}),
    });
  }

  async updateBranch(pr: PrDetail): Promise<void> {
    await this.octokit.pulls.updateBranch({ ...at(pr.repo), pull_number: pr.number, expected_head_sha: pr.headSha });
  }
}

const isFailure = (c: CheckConclusion | null) => c === 'failure' || c === 'timed_out' || c === 'cancelled' || c === 'action_required' || c === 'stale';

function toViewed(s: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'): ViewedState {
  return s === 'VIEWED' ? 'viewed' : s === 'DISMISSED' ? 'changed' : 'unviewed';
}

function toSummary(p: RawPr, me: string): PrSummary {
  const myLatest = p.latestReviews.nodes.find((r) => r.author?.login === me);
  const mine = myLatest?.state;
  const author = p.author?.login ?? 'ghost';
  const reviewed: Reviewer[] = p.latestReviews.nodes
    .filter((r) => r.author && r.author.login !== author && REVIEW_STATE[r.state])
    .map((r) => ({ login: r.author!.login, state: REVIEW_STATE[r.state]! }));
  const asked = p.reviewRequests.nodes.map((n) => n.requestedReviewer?.login ?? n.requestedReviewer?.slug).filter((l): l is string => !!l);
  return {
    repo: p.repository.nameWithOwner,
    number: p.number,
    title: p.title,
    author,
    headRef: p.headRefName,
    baseRef: p.baseRefName,
    mine: author === me,
    reviewDecision: p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : null,
    reviewers: [...reviewed, ...asked.filter((l) => !reviewed.some((r) => r.login === l)).map((login) => ({ login, state: 'requested' as const }))],
    reviewRequested: asked.includes(me),
    url: p.url,
    additions: p.additions,
    deletions: p.deletions,
    updatedAt: p.updatedAt,
    headSha: p.headRefOid,
    isDraft: p.isDraft,
    state: p.state === 'MERGED' ? 'merged' : 'open',
    labels: p.labels.nodes.map((l) => l.name),
    myReviewSha: myLatest?.commit?.oid ?? null,
    myReview: mine === 'APPROVED' ? 'approved' : mine === 'CHANGES_REQUESTED' ? 'changes_requested' : mine === 'COMMENTED' ? 'commented' : null,
    checks: tally(p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    mergeable: p.mergeable === 'UNKNOWN' ? null : p.mergeable === 'MERGEABLE',
    mergeState: toMergeState(p.mergeStateStatus),
    unresolvedThreads: p.reviewThreads.nodes.filter((t) => !t.isResolved).length,
  };
}

const REVIEW_STATE: Record<string, Reviewer['state'] | undefined> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented' };

export function toMergeState(s: string): MergeState {
  const v = s.toLowerCase();
  return v === 'clean' || v === 'behind' || v === 'blocked' || v === 'dirty' || v === 'unstable' || v === 'draft' ? v : 'unknown';
}

/** The repo's allowed merge methods, squash first when it's on. */
export function mergeMethods(r: { squashMergeAllowed: boolean; mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean }): MergeMethod[] {
  const out: MergeMethod[] = [];
  if (r.squashMergeAllowed) out.push('squash');
  if (r.mergeCommitAllowed) out.push('merge');
  if (r.rebaseMergeAllowed) out.push('rebase');
  return out.length ? out : ['merge'];
}

export function tally(contexts: RawContext[]): ChecksTally {
  const t: ChecksTally = { passed: 0, failed: 0, pending: 0, total: contexts.length };
  for (const c of contexts) {
    const result = c.__typename === 'CheckRun' ? (c.status === 'COMPLETED' ? c.conclusion : 'PENDING') : c.state;
    if (result === 'SUCCESS' || result === 'NEUTRAL' || result === 'SKIPPED') t.passed++;
    else if (result === 'PENDING' || result === 'EXPECTED' || result === null) t.pending++;
    else t.failed++;
  }
  return t;
}
