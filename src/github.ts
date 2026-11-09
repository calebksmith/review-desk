import { Octokit } from '@octokit/rest';
import { parsePatch } from './patch';
import type { CheckConclusion, CheckRun, ChecksTally, FileDiff, MergeMethod, MergeState, PrDetail, PrSummary, ViewedState } from './protocol';
import type { DataSource } from './source';

const PR_FIELDS = `
  number title url additions deletions updatedAt isDraft state headRefOid mergeable mergeStateStatus
  reviewThreads(first: 100) { nodes { isResolved } }
  author { login }
  labels(first: 10) { nodes { name } }
  latestReviews(first: 20) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { status conclusion }
    ... on StatusContext { state }
  } } } } } }
`;

interface RawPr {
  number: number; title: string; url: string; additions: number; deletions: number; updatedAt: string;
  isDraft: boolean; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; mergeStateStatus: string;
  reviewThreads: { nodes: { isResolved: boolean }[] };
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  latestReviews: { nodes: { author: { login: string } | null; state: string }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}
type RawContext =
  | { __typename: 'CheckRun'; status: string; conclusion: string | null }
  | { __typename: 'StatusContext'; state: string };

export class GitHubSource implements DataSource {
  readonly sample = false;
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly name: string;
  private login: string | null = null;

  constructor(token: string, readonly repo: string) {
    this.octokit = new Octokit({ auth: token, userAgent: 'review-desk' });
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error(`Repository should look like owner/name, not "${repo}"`);
    this.owner = owner;
    this.name = name;
  }

  async viewer(): Promise<string> {
    if (!this.login) this.login = (await this.octokit.users.getAuthenticated()).data.login;
    return this.login;
  }

  async listPrs(): Promise<PrSummary[]> {
    const me = await this.viewer();
    const data = await this.octokit.graphql<{ repository: { open: { nodes: RawPr[] }; merged: { nodes: RawPr[] } } }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
        open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
        merged: pullRequests(states: MERGED, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
      } }`,
      { owner: this.owner, name: this.name },
    );
    return [...data.repository.open.nodes, ...data.repository.merged.nodes].map((p) => toSummary(p, me));
  }

  async getPr(number: number, sinceSha: string | null): Promise<PrDetail> {
    const me = await this.viewer();
    const data = await this.octokit.graphql<{ repository: { squashMergeAllowed: boolean; mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean; pullRequest: RawPr & {
      id: string; body: string; headRefName: string; baseRefName: string;
      files: { nodes: { path: string; viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED' }[] };
    } } }>(
      `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
        squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
        pullRequest(number: $number) { ${PR_FIELDS} id body headRefName baseRefName
          files(first: 100) { nodes { path viewerViewedState } } }
      } }`,
      { owner: this.owner, name: this.name, number },
    );
    const raw = data.repository.pullRequest;
    const viewed = new Map(raw.files.nodes.map((f) => [f.path, toViewed(f.viewerViewedState)]));

    const files = (await this.octokit.paginate(this.octokit.pulls.listFiles, { owner: this.owner, repo: this.name, pull_number: number, per_page: 100 }))
      .map((f): FileDiff => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        viewed: viewed.get(f.filename) ?? 'unviewed',
        lines: f.patch ? parsePatch(f.patch) : null,
      }));

    const runs = await this.octokit.paginate(this.octokit.checks.listForRef, { owner: this.owner, repo: this.name, ref: raw.headRefOid, per_page: 100 });
    const checkRuns = runs.map((r): CheckRun => ({
      name: r.name,
      app: r.app?.name ?? '',
      status: r.status,
      conclusion: r.conclusion as CheckConclusion | null,
      url: r.html_url ?? null,
      summary: r.output?.summary ?? null,
    }));

    let sinceLastLook: PrDetail['sinceLastLook'] = null;
    if (sinceSha && sinceSha !== raw.headRefOid) {
      try {
        const cmp = await this.octokit.repos.compareCommitsWithBasehead({ owner: this.owner, repo: this.name, basehead: `${sinceSha}...${raw.headRefOid}` });
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
      headRef: raw.headRefName,
      baseRef: raw.baseRefName,
      mergeMethods: mergeMethods(data.repository),
      files,
      checkRuns,
      sinceLastLook,
    };
  }

  async setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> {
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await this.octokit.graphql(`mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: pr.nodeId, path });
  }

  async approve(pr: PrDetail): Promise<void> {
    await this.octokit.pulls.createReview({ owner: this.owner, repo: this.name, pull_number: pr.number, commit_id: pr.headSha, event: 'APPROVE' });
  }

  async merge(pr: PrDetail, method: MergeMethod): Promise<void> {
    await this.octokit.pulls.merge({ owner: this.owner, repo: this.name, pull_number: pr.number, sha: pr.headSha, merge_method: method });
  }

  async updateBranch(pr: PrDetail): Promise<void> {
    await this.octokit.pulls.updateBranch({ owner: this.owner, repo: this.name, pull_number: pr.number, expected_head_sha: pr.headSha });
  }
}

function toViewed(s: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'): ViewedState {
  return s === 'VIEWED' ? 'viewed' : s === 'DISMISSED' ? 'changed' : 'unviewed';
}

function toSummary(p: RawPr, me: string): PrSummary {
  const mine = p.latestReviews.nodes.find((r) => r.author?.login === me)?.state;
  return {
    number: p.number,
    title: p.title,
    author: p.author?.login ?? 'ghost',
    url: p.url,
    additions: p.additions,
    deletions: p.deletions,
    updatedAt: p.updatedAt,
    headSha: p.headRefOid,
    isDraft: p.isDraft,
    state: p.state === 'MERGED' ? 'merged' : 'open',
    labels: p.labels.nodes.map((l) => l.name),
    myReview: mine === 'APPROVED' ? 'approved' : mine === 'CHANGES_REQUESTED' ? 'changes_requested' : mine === 'COMMENTED' ? 'commented' : null,
    checks: tally(p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    mergeable: p.mergeable === 'UNKNOWN' ? null : p.mergeable === 'MERGEABLE',
    mergeState: toMergeState(p.mergeStateStatus),
    unresolvedThreads: p.reviewThreads.nodes.filter((t) => !t.isResolved).length,
  };
}

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
