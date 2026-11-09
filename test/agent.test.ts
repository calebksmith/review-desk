import { describe, expect, it } from 'vitest';
import { fixPrompt } from '../src/agent';
import { SampleSource } from '../src/sample';

describe('fixPrompt', () => {
  it('carries the failure, the PR and a plan that asks before pushing', async () => {
    const pr = await new SampleSource().getPr(55, null);
    const prompt = fixPrompt('acme/web', pr, pr.checkRuns.find((r) => r.name === 'Tests')!);
    expect(prompt).toContain('Repository: acme/web');
    expect(prompt).toContain('Pull request: #55 "Count access-link opens by company"');
    expect(prompt).toContain('Branch: claude/access-link-company → main');
    expect(prompt).toContain('Failed step: Run tests');
    expect(prompt).toContain('```\nFAIL  src/lib/track.test.ts');
    expect(prompt).toContain('separate git worktree');
    expect(prompt).toContain('Don’t push until I agree');
    expect(prompt).not.toContain('Dependabot');
  });

  it('names the other failing checks and adds Dependabot choices for Dependabot PRs', async () => {
    const pr = await new SampleSource().getPr(61, null);
    const prompt = fixPrompt('acme/web', pr, pr.checkRuns.find((r) => r.name === 'checks')!);
    expect(prompt).toContain('Also failing on this PR: lighthouse (at "Run npm ci")');
    expect(prompt).toContain('npm error ERESOLVE could not resolve');
    expect(prompt).toContain('ignore rule for this version in .github/dependabot.yml');
  });

  it('cuts a long description', async () => {
    const pr = { ...(await new SampleSource().getPr(57, null)), body: 'x'.repeat(5000) };
    const prompt = fixPrompt('acme/web', pr, { name: 'Vercel', app: 'Commit status', status: 'completed', conclusion: 'failure', url: null, summary: 'Deployment has failed', failedStep: null, excerpt: null });
    expect(prompt).toContain('Summary: Deployment has failed');
    expect(prompt).toContain(`${'x'.repeat(2000)}…`);
    expect(prompt).not.toContain('x'.repeat(2001));
  });
});
