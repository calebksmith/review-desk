import type { MergeMethod, PrDetail, PrSummary, Reviewer } from './protocol';
import { ago, decide, file, pass, say, sized, type SamplePr } from './sample-kit';
import { teamSeed } from './sample-team';
import type { DataSource } from './source';

// Sample PRs for demos, screenshots and tests. Content is made up; shapes match GitHub.
// "solo" is one reviewer and their agents; "team" is several developers, stacked PRs and required approvals.

function soloSeed(): SamplePr[] {
  const prs: SamplePr[] = [
    {
      summary: { number: 55, title: 'Count access-link opens by company', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(8), headSha: '9d07f3e', isDraft: false, state: 'open', labels: ['review-desk'], myReview: null, checks: { passed: 4, failed: 1, pending: 0, total: 5 }, mergeable: true, mergeState: 'unstable', unresolvedThreads: 0 },
      body: 'Show which company opened each access link, by day.',
      bodyHtml: `<p>Show which company opened each access link, by day, so the weekly report can group opens by company.</p>
<h3>What changed</h3>
<ul><li><code>trackOpen</code> tags each open with the company that owns the link.</li>
<li>A new <code>countByCompany</code> helper groups opens by day and company.</li>
<li>The weekly report prints a table by company, in Pacific time.</li></ul>
<h3>How to check it</h3>
<ol><li>Run <code>npm run report</code>.</li><li>Opens appear under each company, one row per day.</li></ol>
<h3>Notes</h3>
<p>Error logs now show the request path with the token removed. See <a href="https://github.com">the logging guide</a>.</p>`,
      conversation: [
        { kind: 'review', verdict: 'changes_requested', comment: say('calebksmith', 95, '<p>The catch block still logs the full URL, token included. Please redact it in <code>onError</code> too.</p>') },
        { kind: 'thread', id: 'T_55_1', path: 'src/lib/track.ts', line: 61, resolved: true, outdated: false, comments: [
          say('calebksmith', 94, '<p>This line logs <code>req.path</code> but not the company. Can it use the same format as the catch above?</p>'),
          say('claude', 20, '<p>Done in 9d07f3e. Both lines now log the redacted path and the company.</p>'),
        ] },
        { kind: 'comment', comment: say('claude', 15, '<p>Pushed 9d07f3e: <code>onError</code> redacts the token too, with a test. <strong>Tests</strong> still fails on that new test. I’m looking at it next.</p>') },
      ],
      headRef: 'claude/access-link-company',
      files: [
        file('src/lib/track.ts', [
          '@@ -50,7 +50,7 @@ export async function trackOpen(req: Request) {',
          '   const company = companyFor(slug)',
          '   try {',
          '     await record(slug, company)',
          '   } catch (err) {',
          '-    log.error(`error ${req.url} 500`)',
          '+    log.error(`error ${redact(req.url)} 500`)',
          '   }',
          '@@ -60,3 +60,3 @@ export const handlers = {',
          '   onError(err, req) {',
          '+    log.error(`error ${req.path} 500 company=${co}`)',
          '   }',
        ].join('\n')),
        file('src/lib/analytics.ts', [
          '@@ -16,2 +16,5 @@ import { groupBy } from "./util"',
          ' ',
          '+export function countByCompany(opens: Open[]) {',
          '+  return groupBy(opens, (o) => `${o.day}|${o.company}`)',
          '+}',
        ].join('\n')),
        file('scripts/report.mjs', [
          '@@ -12,2 +12,4 @@ const opens = await loadOpens()',
          ' ',
          "+const tz = 'America/Los_Angeles'",
          '+table(countByCompany(opens), { tz })',
        ].join('\n')),
        file('src/lib/track.test.ts', [
          '@@ -28,2 +28,4 @@ describe("trackOpen", () => {',
          ' ',
          '+  it("tags each open with its company", async () => {})',
          '+  it("redacts the token in catch", async () => {})',
        ].join('\n')),
      ],
      checkRuns: [
        pass('Lint', 'GitHub Actions'), pass('Prettier', 'GitHub Actions'), pass('Types', 'GitHub Actions'),
        { name: 'Tests', app: 'GitHub Actions', status: 'completed', conclusion: 'failure', url: 'https://github.com', summary: null, failedStep: 'Run tests',
          excerpt: ['FAIL  src/lib/track.test.ts > trackOpen > redacts the token in onError', 'AssertionError: expected "error /a/abc123?t=s3cr3t 500" to not contain "s3cr3t"', 'Tests  1 failed | 11 passed (12)'] },
        pass('Vercel', 'Vercel', 'Preview ready'),
      ],
    },
    {
      summary: { number: 52, title: 'Add medals to case study cards', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(24), headSha: '0b8e4f1', isDraft: false, state: 'open', labels: ['review-desk'], myReview: null, checks: { passed: 5, failed: 0, pending: 0, total: 5 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 1 },
      body: 'Show each case study’s medal (its small badge icon and name) on its card.',
      bodyHtml: '<p>Show each case study’s medal (its small badge icon and name) on its card.</p><ul><li>Adds <code>MEDALS</code>, with a name and icon for each medal.</li><li>Cards show the icon beside the title and the medal name under it.</li></ul>',
      conversation: [
        { kind: 'thread', id: 'T_52_1', path: 'src/components/WorkCard.tsx', line: 44, resolved: false, outdated: false, comments: [
          say('calebksmith', 180, '<p>Should the medal name sit under the summary instead? It wraps next to long titles on small screens.</p>'),
        ] },
      ],
      headRef: 'claude/case-study-medals',
      files: [
        file('src/components/WorkCard.tsx', [
          '@@ -38,4 +38,10 @@ export function WorkCard({ title, summary, medal }: Props) {',
          '   return (',
          '     <article className="card">',
          '-      <h3>{title}</h3>',
          '+      <header className="card-head">',
          '+        <Medal kind={medal} />',
          '+        <h3>{title}</h3>',
          '+      </header>',
          '+      <span className="medal-name text-label">{medalName(medal)}</span>',
          '       <p>{summary}</p>',
          '@@ -56,2 +62,3 @@ export function WorkCard({ title, summary, medal }: Props) {',
          ' }',
          '+const medalName = (m: MedalKind) => MEDALS[m].name',
        ].join('\n'), 'viewed'),
        file('src/components/icons.tsx', [
          '@@ -6,3 +6,5 @@ import { StarIcon } from "@heroicons/react/24/outline"',
          ' export const icons = {',
          '   star: StarIcon,',
          '+  trophy: TrophyIcon,',
          '+  terminal: CommandLineIcon,',
          ' }',
        ].join('\n')),
        { ...file('src/content/medals.ts', [
          '@@ -0,0 +1,5 @@',
          '+export const MEDALS = {',
          "+  movement: { name: 'Movement', icon: 'trophy' },",
          "+  guardrails: { name: 'Guardrails', icon: 'shield' },",
          "+  loop: { name: 'Review loop', icon: 'terminal' },",
          '+} as const',
        ].join('\n')), status: 'added' },
      ],
      checkRuns: [pass('Lint', 'GitHub Actions'), pass('Prettier', 'GitHub Actions'), pass('Types', 'GitHub Actions'), pass('Tests', 'GitHub Actions', '12 of 12 passed'), pass('Vercel', 'Vercel', 'Preview ready')],
    },
    {
      summary: { number: 57, title: 'Fix dates on the Experience page', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(62), headSha: 'e1f04aa', isDraft: false, state: 'open', labels: ['review-desk'], myReview: null, checks: { passed: 4, failed: 0, pending: 1, total: 5 }, mergeable: true, mergeState: 'behind', unresolvedThreads: 0 },
      body: 'Use one date format across the Experience page.',
      bodyHtml: '<p>Use one date format across the Experience page: short month and year, like <em>Jan 2023</em>.</p>',
      conversation: [],
      headRef: 'claude/experience-dates',
      files: [file('src/content/experience.mdx', [
        '@@ -10,3 +10,3 @@',
        ' ## Vimocity',
        '-2023 – Present',
        '+Jan 2023 – Present',
        ' ',
        '@@ -17,3 +17,3 @@',
        ' ## Earlier work',
        '-6/2019 – 12/2022',
        '+Jun 2019 – Dec 2022',
        ' ',
      ].join('\n'))],
      checkRuns: [pass('Lint', 'GitHub Actions'), pass('Prettier', 'GitHub Actions'), pass('Types', 'GitHub Actions'), pass('Tests', 'GitHub Actions', '8 of 8 passed'),
        { name: 'Vercel', app: 'Commit status', status: 'pending', conclusion: null, url: 'https://github.com', summary: 'Building preview', failedStep: null, excerpt: null }],
    },
    {
      summary: { number: 60, title: 'Bump vite from 6.3.1 to 6.3.5', author: 'dependabot', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(60 * 5), headSha: '5c1d9a2', isDraft: false, state: 'open', labels: ['dependencies'], myReview: null, checks: { passed: 3, failed: 0, pending: 0, total: 3 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 0 },
      body: 'Bumps vite from 6.3.1 to 6.3.5.',
      bodyHtml: '<p>Bumps <a href="https://github.com">vite</a> from 6.3.1 to 6.3.5.</p><details><summary>Release notes</summary><ul><li>Fix HMR for CSS modules</li><li>Fix a dev server crash on Windows paths</li></ul></details>',
      conversation: [],
      headRef: 'dependabot/npm_and_yarn/vite-6.3.5',
      files: [file('package-lock.json', ['@@ -4120,3 +4120,3 @@', '     "node_modules/vite": {', '-      "version": "6.3.1",', '+      "version": "6.3.5",'].join('\n'))],
      checkRuns: [pass('checks', 'GitHub Actions'), pass('lighthouse', 'GitHub Actions'), pass('Vercel', 'Commit status', 'Deployment has completed')],
    },
    {
      summary: { number: 61, title: 'Bump eslint from 9.39.5 to 10.12.0', author: 'dependabot', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(60 * 30), headSha: 'b77e310', isDraft: false, state: 'open', labels: ['dependencies'], myReview: null, checks: { passed: 1, failed: 2, pending: 0, total: 3 }, mergeable: true, mergeState: 'unstable', unresolvedThreads: 0 },
      body: 'Bumps eslint from 9.39.5 to 10.12.0.',
      bodyHtml: '<p>Bumps <a href="https://github.com">eslint</a> from 9.39.5 to 10.12.0.</p>',
      conversation: [],
      headRef: 'dependabot/npm_and_yarn/eslint-10.12.0',
      files: [file('package.json', ['@@ -40,3 +40,3 @@', '     "@types/node": "^22",', '-    "eslint": "^9",', '+    "eslint": "^10",'].join('\n'))],
      checkRuns: [
        { name: 'checks', app: 'GitHub Actions', status: 'completed', conclusion: 'failure', url: 'https://github.com', summary: null, failedStep: 'Run npm ci',
          excerpt: ['npm error code ERESOLVE', 'npm error ERESOLVE could not resolve', 'npm error While resolving: eslint-plugin-jsx-a11y@6.10.2', 'npm error Found: eslint@10.12.0'] },
        { name: 'lighthouse', app: 'GitHub Actions', status: 'completed', conclusion: 'failure', url: 'https://github.com', summary: null, failedStep: 'Run npm ci', excerpt: ['npm error code ERESOLVE', 'npm error ERESOLVE could not resolve'] },
        pass('Vercel Preview Comments', 'Vercel'),
      ],
    },
    {
      summary: { number: 48, title: 'Tighten homepage spacing', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(60 * 26), headSha: 'a71c2d0', isDraft: false, state: 'merged', labels: [], myReview: 'approved', checks: { passed: 5, failed: 0, pending: 0, total: 5 }, mergeable: null, mergeState: 'unknown', unresolvedThreads: 0 },
      body: 'Use the 8px scale on the homepage sections.',
      bodyHtml: '<p>Use the 8px scale on the homepage sections.</p>',
      conversation: [{ kind: 'review', verdict: 'approved', comment: say('calebksmith', 60 * 27, '') }],
      headRef: 'homepage-spacing',
      files: [file('src/app/page.tsx', ['@@ -20,2 +20,2 @@', '-<section className="mt-6">', '+<section className="mt-8">'].join('\n'), 'viewed')],
      checkRuns: [pass('Lint', 'GitHub Actions'), pass('Tests', 'GitHub Actions')],
    },
  ];
  return sized(prs);
}

export type SampleKind = 'solo' | 'team';

const SETS: Record<SampleKind, { repo: string; required: number; seed: () => SamplePr[] }> = {
  solo: { repo: 'calebksmith/portfolio', required: 0, seed: soloSeed },
  // One approval from someone other than the author before anything merges, like a protected main.
  team: { repo: 'acme/storefront', required: 1, seed: teamSeed },
};

export class SampleSource implements DataSource {
  readonly repo: string;
  readonly sample = true;
  private readonly me = 'calebksmith';
  private readonly required: number;
  private prs: SamplePr[];

  constructor(readonly kind: SampleKind = 'solo') {
    const set = SETS[kind];
    this.repo = set.repo;
    this.required = set.required;
    this.prs = set.seed();
  }

  async viewer(): Promise<string> { return this.me; }

  async listPrs(): Promise<PrSummary[]> { return this.prs.map((p) => this.summarize(p)); }

  async getPr(number: number, sinceSha: string | null): Promise<PrDetail> {
    const p = this.find(number);
    // #55 always shows one new commit, so the banner can be seen in demos.
    const sinceLastLook = number === 55
      ? { fromSha: sinceSha ?? 'c44e2b9', toSha: p.summary.headSha, commits: 1, files: p.files.filter((f) => f.path === 'src/lib/track.test.ts') }
      : null;
    return {
      ...this.summarize(p), nodeId: `PR_${number}`, body: p.body, bodyHtml: p.bodyHtml, conversation: structuredClone(p.conversation),
      mergeMethods: ['squash', 'rebase'], files: p.files.map((f) => ({ ...f })), checkRuns: p.checkRuns, sinceLastLook,
    };
  }

  async setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> {
    const f = this.find(pr.number).files.find((x) => x.path === path);
    if (f) f.viewed = viewed ? 'viewed' : 'unviewed';
  }

  async approve(pr: PrDetail): Promise<void> {
    const p = this.find(pr.number);
    if (p.summary.author === this.me) throw Object.assign(new Error('You can’t approve your own pull request.'), { status: 422 });
    p.summary.myReview = 'approved';
  }

  /** Like GitHub: refuses without the required approvals, and moves PRs stacked on this one onto its base. */
  async merge(pr: PrDetail, _method: MergeMethod): Promise<void> {
    const p = this.find(pr.number);
    const s = this.summarize(p);
    if (this.required && s.reviewDecision !== 'approved') {
      throw Object.assign(new Error(`At least ${this.required} approving review is required by reviewers with write access.`), { status: 405 });
    }
    p.summary.state = 'merged';
    for (const child of this.prs) if (child.base === p.headRef && child.summary.state === 'open') child.base = p.base ?? 'main';
  }

  async comment(pr: PrDetail, body: string): Promise<void> {
    const html = `<p>${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`;
    this.find(pr.number).conversation.push({ kind: 'comment', comment: { ...say(this.me, 0, html), text: body } });
  }

  async updateBranch(pr: PrDetail): Promise<void> { this.find(pr.number).summary.mergeState = 'clean'; }

  /** Adds what GitHub works out: branches, whose PR it is, the viewer's review among the others, the decision. */
  private summarize(p: SamplePr): PrSummary {
    const s = p.summary;
    const others = (p.reviewers ?? []).filter((r) => r.login !== this.me || !s.myReview);
    const reviewers: Reviewer[] = s.myReview ? [...others, { login: this.me, state: s.myReview }] : others;
    return {
      ...s,
      headRef: p.headRef,
      baseRef: p.base ?? 'main',
      mine: s.author === this.me,
      reviewers,
      reviewRequested: reviewers.some((r) => r.login === this.me && r.state === 'requested'),
      reviewDecision: decide(reviewers, this.required, s.author),
    };
  }

  private find(number: number): SamplePr {
    const p = this.prs.find((x) => x.summary.number === number);
    if (!p) throw new Error(`No sample PR #${number}`);
    return p;
  }
}
