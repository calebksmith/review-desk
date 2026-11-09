import { describe, expect, it } from 'vitest';
import { fixPrompt, threadPrompt } from '../src/agent';
import type { ConversationItem } from '../src/protocol';
import { SampleSource } from '../src/sample';

describe('fixPrompt', () => {
  it('says what failed, where, and the two rules', async () => {
    const pr = await new SampleSource().getPr(55, null);
    const prompt = fixPrompt('acme/web', pr, pr.checkRuns.find((r) => r.name === 'Tests')!);
    expect(prompt.split('\n')[0]).toBe('The "Tests" check is failing at "Run tests". Find the cause and propose a fix.');
    expect(prompt).toContain('PR: acme/web#55 "Count access-link opens by company"');
    expect(prompt).toContain('Branch: claude/access-link-company');
    expect(prompt).toContain('```\nFAIL  src/lib/track.test.ts');
    expect(prompt).toContain('separate git worktree');
    expect(prompt).toContain('don’t push until I agree');
    expect(prompt).not.toContain('Dependabot');
    expect(prompt).not.toContain(pr.body);
  });

  it('names other failing checks and asks Dependabot PRs for fix-or-ignore', async () => {
    const pr = await new SampleSource().getPr(61, null);
    const prompt = fixPrompt('acme/web', pr, pr.checkRuns.find((r) => r.name === 'checks')!);
    expect(prompt).toContain('Also failing: lighthouse');
    expect(prompt).toContain('npm error ERESOLVE could not resolve');
    expect(prompt).toContain('I’ll ignore it from Review Desk');
  });

  it('falls back to the summary when there are no log lines', async () => {
    const pr = await new SampleSource().getPr(57, null);
    const prompt = fixPrompt('acme/web', pr, { name: 'Vercel', app: 'Commit status', status: 'completed', conclusion: 'failure', url: null, summary: 'Deployment has failed', failedStep: null, excerpt: null });
    expect(prompt.split('\n')[0]).toBe('The "Vercel" check is failing. Find the cause and propose a fix.');
    expect(prompt).toContain('\nDeployment has failed\n');
  });
});

describe('threadPrompt', () => {
  it('quotes the thread with who said what', async () => {
    const pr = await new SampleSource().getPr(55, null);
    const thread = pr.conversation.find((i) => i.kind === 'thread') as Extract<ConversationItem, { kind: 'thread' }>;
    const prompt = threadPrompt('acme/web', pr, thread);
    expect(prompt.split('\n')[0]).toBe('Address this review comment on src/lib/track.ts:61.');
    expect(prompt).toContain('> calebksmith: This line logs req.path but not the company.');
    expect(prompt).toContain('> claude: Done in 9d07f3e.');
    expect(prompt).toContain('one-line reply');
  });
});
