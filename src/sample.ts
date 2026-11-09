import { parsePatch } from './patch';
import type { CheckRun, FileDiff, MergeMethod, PrDetail, PrSummary } from './protocol';
import type { DataSource } from './source';

// Sample PRs for demos, screenshots and tests. Content is made up; shapes match GitHub.

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const file = (path: string, patch: string, viewed: FileDiff['viewed'] = 'unviewed'): FileDiff => {
  const lines = parsePatch(patch);
  return { path, status: 'modified', viewed, lines,
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length };
};

const pass = (name: string, app: string, summary: string | null = null): CheckRun => ({ name, app, status: 'completed', conclusion: 'success', url: 'https://github.com', summary });

interface SamplePr { summary: PrSummary; files: FileDiff[]; checkRuns: CheckRun[]; body: string; headRef: string }

function seed(): SamplePr[] {
  const prs: SamplePr[] = [
    {
      summary: { number: 55, title: 'Count access-link opens by company', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(8), headSha: '9d07f3e', isDraft: false, state: 'open', labels: ['review-desk'], myReview: null, checks: { passed: 4, failed: 1, pending: 0, total: 5 }, mergeable: true, mergeState: 'unstable', unresolvedThreads: 0 },
      body: 'Show which company opened each access link, by day.',
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
        { name: 'Tests', app: 'GitHub Actions', status: 'completed', conclusion: 'failure', url: 'https://github.com', summary: '11 of 12 passed. Failed: redacts token in onError.' },
        pass('Vercel', 'Vercel', 'Preview ready'),
      ],
    },
    {
      summary: { number: 52, title: 'Add medals to case study cards', author: 'claude', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(24), headSha: '0b8e4f1', isDraft: false, state: 'open', labels: ['review-desk'], myReview: null, checks: { passed: 5, failed: 0, pending: 0, total: 5 }, mergeable: true, mergeState: 'clean', unresolvedThreads: 1 },
      body: 'Show each case study’s medal (its small badge icon and name) on its card.',
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
        { name: 'Vercel', app: 'Vercel', status: 'in_progress', conclusion: null, url: 'https://github.com', summary: 'Building preview' }],
    },
    {
      summary: { number: 48, title: 'Tighten homepage spacing', author: 'calebksmith', url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(60 * 26), headSha: 'a71c2d0', isDraft: false, state: 'merged', labels: [], myReview: 'approved', checks: { passed: 5, failed: 0, pending: 0, total: 5 }, mergeable: null, mergeState: 'unknown', unresolvedThreads: 0 },
      body: 'Use the 8px scale on the homepage sections.',
      headRef: 'homepage-spacing',
      files: [file('src/app/page.tsx', ['@@ -20,2 +20,2 @@', '-<section className="mt-6">', '+<section className="mt-8">'].join('\n'), 'viewed')],
      checkRuns: [pass('Lint', 'GitHub Actions'), pass('Tests', 'GitHub Actions')],
    },
  ];
  for (const p of prs) {
    p.summary.additions = p.files.reduce((n, f) => n + f.additions, 0);
    p.summary.deletions = p.files.reduce((n, f) => n + f.deletions, 0);
  }
  return prs;
}

export class SampleSource implements DataSource {
  readonly repo = 'calebksmith/portfolio';
  readonly sample = true;
  private prs = seed();

  async viewer(): Promise<string> { return 'calebksmith'; }

  async listPrs(): Promise<PrSummary[]> { return this.prs.map((p) => ({ ...p.summary })); }

  async getPr(number: number, sinceSha: string | null): Promise<PrDetail> {
    const p = this.find(number);
    // #55 always shows one new commit, so the banner can be seen in demos.
    const sinceLastLook = number === 55
      ? { fromSha: sinceSha ?? 'c44e2b9', toSha: p.summary.headSha, commits: 1, files: p.files.filter((f) => f.path === 'src/lib/track.test.ts') }
      : null;
    return {
      ...p.summary, nodeId: `PR_${number}`, body: p.body, headRef: p.headRef, baseRef: 'main',
      mergeMethods: ['squash', 'rebase'], files: p.files.map((f) => ({ ...f })), checkRuns: p.checkRuns, sinceLastLook,
    };
  }

  async setViewed(pr: PrDetail, path: string, viewed: boolean): Promise<void> {
    const f = this.find(pr.number).files.find((x) => x.path === path);
    if (f) f.viewed = viewed ? 'viewed' : 'unviewed';
  }

  async approve(pr: PrDetail): Promise<void> { this.find(pr.number).summary.myReview = 'approved'; }

  async merge(pr: PrDetail, _method: MergeMethod): Promise<void> { this.find(pr.number).summary.state = 'merged'; }

  async updateBranch(pr: PrDetail): Promise<void> { this.find(pr.number).summary.mergeState = 'clean'; }

  private find(number: number): SamplePr {
    const p = this.prs.find((x) => x.summary.number === number);
    if (!p) throw new Error(`No sample PR #${number}`);
    return p;
  }
}
