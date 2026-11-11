import { Octokit } from '@octokit/rest';
import { COMMENT_FIELDS, countFindings, toConversation, type RawComment, type RawReview, type RawThread } from './conversation';
import { logExcerpt } from './logs';
import { parsePatch } from './patch';
import type { CheckConclusion, CheckRun, ChecksTally, Draft, FileDiff, MergeMethod, MergeState, PrDetail, PrSummary, ReviewEvent, Reviewer, ViewedState } from './protocol';
import type { Budget } from './refresh';
import { combine, scopeLabel, searchQueries, type Scope } from './scope';
import { parseDependsOn, parseLinear } from './signals';
import type { DataSource, Sent } from './source';

const PR_FIELDS = `
  number title url additions deletions updatedAt isDraft state headRefOid mergeable mergeStateStatus
  repository { nameWithOwner }
  headRefName baseRefName isCrossRepository reviewDecision createdAt body
  milestone { title dueOn }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  recentThreads: reviewThreads(last: 20) { nodes { isResolved comments(first: 1) { nodes { body } } } }
  author { login }
  labels(first: 10) { nodes { name } }
  latestReviews(first: 20) { nodes { author { login } state commit { oid } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { status conclusion }
    ... on StatusContext { state }
  } } } } } }
`;

export interface RawPr {
  repository: { nameWithOwner: string };
  number: number; title: string; url: string; additions: number; deletions: number; updatedAt: string;
  isDraft: boolean; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string;
  createdAt: string; body: string; milestone: { title: string; dueOn: string | null } | null;
  timelineItems: { nodes: { createdAt?: string; requestedReviewer?: { login?: string } | null }[] };
  headRefName: string; baseRefName: string; isCrossRepository: boolean; reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string } | null }[] };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; mergeStateStatus: string;
  reviewThreads: { nodes: { isResolved: boolean }[] };
  /** The latest threads with their first comment, for the P0/P1 count. Reading every thread's comment cost ~80% of the queue. */
  recentThreads: { nodes: { isResolved: boolean; comments: { nodes: { body: string }[] } }[] };
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
  private allowance: Budget | null = null;
  /** Failed jobs already looked up, by job id: a finished job's steps and log don't change. */
  private readonly failures = new Map<number, Pick<CheckRun, 'failedStep' | 'excerpt'>>();

  /** GitHub's hourly allowance as of the last queue load. */
  budget(): Budget | null { return this.allowance; }

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
    const found = await this.octokit.graphql<Record<string, { nodes: (RawPr | Record<string, never>)[] }> & { rateLimit: Budget }>(
      `query($a: String!, $b: String!, $c: String!, $m: String!) {
        rateLimit { remaining limit resetAt }
        a: search(query: $a, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        b: search(query: $b, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        c: search(query: $c, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
        m: search(query: $m, type: ISSUE, first: 20) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
      }`,
      { a: q.open[0], b: q.open[1], c: q.open[2], m: q.merged },
    );
    this.allowance = found.rateLimit;
    const { rateLimit: _, ...results } = found;
    // review-requested:@me (search b) includes requests made to your teams, which the PR's reviewRequests can't
    // tell apart from teams you aren't on without read:org. Every PR it finds is one you've been asked to review.
    const asked = new Set((found.b?.nodes ?? []).filter((n): n is RawPr => 'number' in n).map((p) => `${p.repository.nameWithOwner}#${p.number}`));
    const searched = Object.values(results).flatMap((r) => (r as { nodes: (RawPr | Record<string, never>)[] }).nodes.filter((n): n is RawPr => 'number' in n))
      .map((p) => toSummary(p, me, asked.has(`${p.repository.nameWithOwner}#${p.number}`)));
    const full = await Promise.all(this.what.full.map((r) => this.repoPrs(r, me)));
    return combine([searched, ...full]);
  }

  private async repoPrs(repo: string, me: string): Promise<PrSummary[]> {
    const { owner, repo: name } = at(repo);
    // The same review-requested:@me search as the combined view, for team requests; numbers only, so it's cheap.
    const data = await this.octokit.graphql<{ rateLimit: Budget; repository: { open: { nodes: RawPr[] }; merged: { nodes: RawPr[] } }; asked: { nodes: { number?: number }[] } }>(
      `query($owner: String!, $name: String!, $asked: String!) { rateLimit { remaining limit resetAt } repository(owner: $owner, name: $name) { ${REPO_PRS} }
        asked: search(query: $asked, type: ISSUE, first: 100) { nodes { ... on PullRequest { number } } } }`,
      { owner, name, asked: requestedQuery(repo) },
    );
    this.allowance = data.rateLimit;
    const asked = new Set(data.asked.nodes.map((n) => n.number));
    return [...data.repository.open.nodes, ...data.repository.merged.nodes].map((p) => toSummary(p, me, asked.has(p.number)));
  }

  async getPr(repo: string, number: number, sinceSha: string | null): Promise<PrDetail> {
    const me = await this.viewer();
    const { owner, repo: name } = at(repo);
    const data = await this.octokit.graphql<{ repository: { squashMergeAllowed: boolean; mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean; pullRequest: RawPr & {
      id: string; body: string; bodyHTML: string;
      files: { nodes: { path: string; viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED' }[] };
      comments: { nodes: RawComment[] };
      reviews: { nodes: RawReview[] };
      pending: { nodes: { author: { login: string } | null; comments: { totalCount: number } }[] };
      threads: { nodes: RawThread[] };
    } } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
        squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
        pullRequest(number: $number) { ${PR_FIELDS} id body bodyHTML
          files(first: 100) { nodes { path viewerViewedState } }
          comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
          reviews(last: 50) { nodes { author { login } state submittedAt body bodyHTML url } }
          pending: reviews(states: PENDING, first: 1) { nodes { author { login } comments { totalCount } } }
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

    const [runs, statuses, required, compatibility] = await Promise.all([
      this.octokit.paginate(this.octokit.checks.listForRef, { owner, repo: name, ref: raw.headRefOid, per_page: 100 }),
      this.octokit.repos.getCombinedStatusForRef({ owner, repo: name, ref: raw.headRefOid, per_page: 100 }),
      this.requiredChecks(owner, name, number),
      /dependabot/i.test(raw.author?.login ?? '') ? compatibilityScore(raw.body) : Promise.resolve(null),
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
        required: required.has(r.name),
        seconds: r.started_at && r.completed_at ? Math.round((Date.parse(r.completed_at) - Date.parse(r.started_at)) / 1000) : null,
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
        required: required.has(st.context),
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
      compatibility,
      pendingReview: raw.pending.nodes.filter((r) => r.author?.login === me).map((r) => ({ comments: r.comments.totalCount }))[0] ?? null,
      files,
      checkRuns,
      sinceLastLook,
    };
  }

  /**
   * Names of the checks branch protection requires. Asked separately so a token that can't read it only loses
   * the "Required" marks (checks then count as optional), not the whole PR.
   */
  private async requiredChecks(owner: string, name: string, number: number): Promise<Set<string>> {
    try {
      const d = await this.octokit.graphql<{ repository: { pullRequest: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: { name?: string; context?: string; isRequired?: boolean }[] } } | null } }[] } } } }>(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
            ... on CheckRun { name isRequired(pullRequestNumber: $number) }
            ... on StatusContext { context isRequired(pullRequestNumber: $number) }
          } } } } } } } } }`,
        { owner, name, number },
      );
      const nodes = d.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      return new Set(nodes.filter((n) => n.isRequired).map((n) => (n.name ?? n.context)!).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /** The failed step of an Actions job and the error lines from its log. Logs can expire; then it's just the step. */
  private async jobFailure(repo: string, jobId: number): Promise<Pick<CheckRun, 'failedStep' | 'excerpt'>> {
    const known = this.failures.get(jobId);
    if (known) return known;
    let failedStep: string | null = null;
    try {
      const job = await this.octokit.actions.getJobForWorkflowRun({ ...at(repo), job_id: jobId });
      failedStep = job.data.steps?.find((st) => st.conclusion === 'failure')?.name ?? null;
      const log = await this.octokit.actions.downloadJobLogsForWorkflowRun({ ...at(repo), job_id: jobId });
      const found = { failedStep, excerpt: typeof log.data === 'string' ? logExcerpt(log.data) : null };
      this.failures.set(jobId, found);
      return found;
    } catch {
      return { failedStep, excerpt: null };
    }
  }

  async setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await this.octokit.graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: pr.nodeId, path });
  }

  /** Through your pending review, if you have one: GitHub allows one per person per PR, so a new review would fail. */
  async approve(pr: PrDetail): Promise<void> {
    await this.submitReview(pr, 'APPROVE', '', []);
  }

  async merge(pr: PrDetail, method: MergeMethod): Promise<void> {
    await this.octokit.pulls.merge({ ...at(pr.repo), pull_number: pr.number, sha: pr.headSha, merge_method: method });
  }

  async comment(pr: PrDetail, body: string): Promise<void> {
    await this.octokit.issues.createComment({ ...at(pr.repo), issue_number: pr.number, body });
  }

  /**
   * Sends a review the way github.com does: into your pending review (the one you may have started in the
   * browser, or a new one), with each held-back comment and reply, then submitted with the verdict. GitHub allows
   * one pending review per person per PR, so starting a second would fail. Resolves follow the submit; once it's
   * submitted the review is sent, so a resolve that fails is counted rather than thrown (retrying would post twice).
   */
  async submitReview(pr: PrDetail, event: ReviewEvent, body: string, drafts: Draft[]): Promise<Sent> {
    const existing = await this.pendingReviewId(pr);
    const id = existing ?? (await this.startReview(pr));
    const added: string[] = [];
    try {
      await this.addToReview(id, pr, drafts, added);
      await this.octokit.graphql('mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { clientMutationId } }', { id, event, body: body || null });
    } catch (err) {
      // A review this call started and couldn't finish would block the next one; one you started stays yours.
      if (!existing) await this.discardReview(id);
      // In a review of yours, the comments added so far stay in it: name them, so a retry doesn't post them twice.
      else if (err instanceof Error) Object.assign(err, { added });
      throw err;
    }
    return this.resolveAll(drafts);
  }

  /**
   * One comment or reply, posted now: a review with just that comment, submitted as a comment, which is what
   * GitHub's "Add single comment" does. Not while a review of yours is in progress: GitHub doesn't allow it either.
   */
  async commentNow(pr: PrDetail, d: Draft): Promise<Sent> {
    if (await this.pendingReviewId(pr)) throw new Error('You have a review in progress on this PR. Add this comment to your review and submit it, or finish that review first.');
    const id = await this.startReview(pr);
    try {
      await this.addToReview(id, pr, [d]);
      await this.octokit.graphql('mutation($id: ID!) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: COMMENT }) { clientMutationId } }', { id });
    } catch (err) {
      await this.discardReview(id);
      throw err;
    }
    return this.resolveAll([d]);
  }

  /** Resolves the threads replies asked to, after they're posted. Each is tried; the ones GitHub refused are counted. */
  private async resolveAll(drafts: Draft[]): Promise<Sent> {
    let unresolved = 0;
    for (const d of drafts.filter((x) => x.replyTo && x.resolve)) {
      try { await this.resolve(d.replyTo!); } catch { unresolved++; }
    }
    return { unresolved };
  }

  /** Your pending review on this PR, if you have one. GitHub only shows a pending review to its author. */
  private async pendingReviewId(pr: PrDetail): Promise<string | null> {
    const me = await this.viewer();
    const d = await this.octokit.graphql<{ node: { reviews: { nodes: { id: string; author: { login: string } | null }[] } } }>(
      'query($id: ID!) { node(id: $id) { ... on PullRequest { reviews(states: PENDING, first: 5) { nodes { id author { login } } } } } }', { id: pr.nodeId },
    );
    return d.node.reviews.nodes.find((r) => r.author?.login === me)?.id ?? null;
  }

  private async startReview(pr: PrDetail): Promise<string> {
    const d = await this.octokit.graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
      'mutation($pr: ID!, $sha: GitObjectID!) { addPullRequestReview(input: { pullRequestId: $pr, commitOID: $sha }) { pullRequestReview { id } } }', { pr: pr.nodeId, sha: pr.headSha },
    );
    return d.addPullRequestReview.pullRequestReview.id;
  }

  /** New comments on lines become threads in the review; replies join their threads, as part of the same review. */
  private async addToReview(id: string, pr: PrDetail, drafts: Draft[], added: string[] = []): Promise<void> {
    for (const d of drafts) {
      if (d.sent) { added.push(d.id); continue; }
      if (d.replyTo) {
        await this.octokit.graphql('mutation($id: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewId: $id, pullRequestReviewThreadId: $thread, body: $body }) { clientMutationId } }', { id, thread: d.replyTo, body: d.body });
      } else if (d.line != null) {
        const range = d.startLine && d.startLine !== d.line ? { startLine: d.startLine, startSide: d.side } : {};
        await this.octokit.graphql('mutation($id: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) { addPullRequestReviewThread(input: { pullRequestReviewId: $id, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body }) { clientMutationId } }',
          { id, path: d.path, line: d.line, side: d.side, body: d.body, startLine: null, startSide: null, ...range });
      }
      added.push(d.id);
    }
  }

  private async discardReview(id: string): Promise<void> {
    await this.octokit.graphql('mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }', { id }).catch(() => {});
  }

  async setDraft(pr: PrDetail, draft: boolean): Promise<void> {
    const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    await this.octokit.graphql(`mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, { id: pr.nodeId });
  }

  async resolveThread(_pr: PrDetail, threadId: string): Promise<void> {
    await this.resolve(threadId);
  }

  private async resolve(threadId: string): Promise<void> {
    await this.octokit.graphql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }', { id: threadId });
  }

  async updateBranch(pr: PrDetail): Promise<void> {
    await this.octokit.pulls.updateBranch({ ...at(pr.repo), pull_number: pr.number, expected_head_sha: pr.headSha });
  }
}

/**
 * Dependabot's compatibility score, from the badge its description links to (the number is only in the badge
 * image, a public GitHub endpoint). Null when there's no badge or it can't be read quickly.
 */
export async function compatibilityScore(body: string): Promise<number | null> {
  const url = /https:\/\/dependabot-badges\.githubapp\.com\/badges\/compatibility_score\?[^)\s"']+/.exec(body)?.[0];
  if (!url) return null;
  try {
    const res = await fetch(url.replace(/&amp;/g, '&'), { signal: AbortSignal.timeout(3000) });
    return parseScore(await res.text());
  } catch {
    return null;
  }
}

/** The percentage in a compatibility badge's SVG; null for "unknown". */
export function parseScore(svg: string): number | null {
  const m = />\s*(\d{1,3})%\s*</.exec(svg);
  return m ? Number(m[1]) : null;
}

const isFailure = (c: CheckConclusion | null) => c === 'failure' || c === 'timed_out' || c === 'cancelled' || c === 'action_required' || c === 'stale';

function toViewed(s: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'): ViewedState {
  return s === 'VIEWED' ? 'viewed' : s === 'DISMISSED' ? 'changed' : 'unviewed';
}

/** Open PRs in one repo where you, or a team you're on, have been asked to review. */
export const requestedQuery = (repo: string) => `repo:${repo} is:pr is:open review-requested:@me`;

/** `requested`: GitHub's review-requested:@me search found it, which counts requests to your teams. */
export function toSummary(p: RawPr, me: string, requested = false): PrSummary {
  const myLatest = p.latestReviews.nodes.find((r) => r.author?.login === me);
  const mine = myLatest?.state;
  const author = p.author?.login ?? 'ghost';
  const reviewed: Reviewer[] = p.latestReviews.nodes
    .filter((r) => r.author && r.author.login !== author && REVIEW_STATE[r.state])
    .map((r) => ({ login: r.author!.login, state: REVIEW_STATE[r.state]! }));
  // A team's name needs the read:org permission, which Review Desk doesn't ask for; a team request reads "a team".
  const asked = p.reviewRequests.nodes.map((n) => n.requestedReviewer?.login ?? (n.requestedReviewer?.__typename === 'Team' ? 'a team' : undefined)).filter((l): l is string => !!l);
  return {
    repo: p.repository.nameWithOwner,
    number: p.number,
    title: p.title,
    author,
    headRef: p.headRefName,
    fromFork: p.isCrossRepository,
    baseRef: p.baseRefName,
    mine: author === me,
    reviewDecision: p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : null,
    reviewers: [...reviewed, ...asked.filter((l) => !reviewed.some((r) => r.login === l)).map((login) => ({ login, state: 'requested' as const }))],
    reviewRequested: requested || asked.includes(me),
    createdAt: p.createdAt,
    requestedAt: p.timelineItems.nodes.filter((n) => n.requestedReviewer?.login === me).map((n) => n.createdAt!).sort().at(-1) ?? null,
    milestone: p.milestone,
    dependsOn: parseDependsOn(p.body),
    linear: parseLinear({ title: p.title, headRef: p.headRefName, body: p.body }),
    findingCounts: countFindings(p.recentThreads.nodes.filter((t) => !t.isResolved).map((t) => t.comments.nodes[0]?.body ?? '')),
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
