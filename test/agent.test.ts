import { describe, expect, it } from 'vitest';
import { conflictPrompt, fixPrompt, resolvePrompt, threadPrompt, workRules, type Finding } from '../src/agent';
import type { ConversationItem } from '../src/protocol';
import { SampleSource } from '../src/sample';

describe('fixPrompt', () => {
  it('says what failed, where, and where to work', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 55, null);
    const prompt = fixPrompt(pr, pr.checkRuns.find((r) => r.name === 'Tests')!);
    expect(prompt.split('\n')[0]).toBe('The "Tests" check is failing at "Run tests". Find the cause and propose a fix.');
    expect(prompt).toContain('PR: calebksmith/portfolio#55 "Count access-link opens by company"');
    expect(prompt).toContain('Branch: claude/access-link-company');
    expect(prompt).toContain('```\nFAIL  src/lib/track.test.ts');
    expect(prompt).toContain('Where to work:');
    expect(prompt).toContain('Don’t push until I agree.');
    expect(prompt).not.toContain('Dependabot');
    expect(prompt).not.toContain(pr.body);
  });

  it('names other failing checks and asks Dependabot PRs for fix-or-ignore', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 61, null);
    const prompt = fixPrompt(pr, pr.checkRuns.find((r) => r.name === 'checks')!);
    expect(prompt).toContain('Also failing: lighthouse');
    expect(prompt).toContain('npm error ERESOLVE could not resolve');
    expect(prompt).toContain('I’ll ignore it from Review Desk');
  });

  it('falls back to the summary when there are no log lines', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 57, null);
    const prompt = fixPrompt(pr, { name: 'Vercel', app: 'Commit status', status: 'completed', conclusion: 'failure', url: null, summary: 'Deployment has failed', failedStep: null, excerpt: null });
    expect(prompt.split('\n')[0]).toBe('The "Vercel" check is failing. Find the cause and propose a fix.');
    expect(prompt).toContain('\nDeployment has failed\n');
  });
});

describe('threadPrompt', () => {
  it('quotes the thread with who said what', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 55, null);
    const thread = pr.conversation.find((i) => i.kind === 'thread') as Extract<ConversationItem, { kind: 'thread' }>;
    const prompt = threadPrompt(pr, thread);
    expect(prompt.split('\n')[0]).toBe('Address this review comment on src/lib/track.ts:61.');
    expect(prompt).toContain('> calebksmith: This line logs req.path but not the company.');
    expect(prompt).toContain('> claude: Done in 9d07f3e.');
    expect(prompt).toContain('one-line reply');
  });
});

describe('conflictPrompt', () => {
  it('asks to merge the base in and explain each resolution', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 57, null);
    const prompt = conflictPrompt(pr);
    expect(prompt.split('\n')[0]).toBe('This PR has merge conflicts with main. Merge main into the branch, resolve the conflicts, and show me how you resolved each one.');
    expect(prompt).toContain('Branch: claude/experience-dates');
    expect(prompt).toContain('Don’t push until I agree.');
  });
});

describe('resolvePrompt', () => {
  const findings = async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 58, null);
    const threads = pr.conversation.flatMap((it): Finding[] => (it.kind === 'thread' ? [{ kind: 'thread', thread: it }] : []));
    const draft: Finding = { kind: 'draft', draft: { id: 'A_1', path: 'src/app/work/page.tsx', line: 23, side: 'RIGHT', from: 'agent', severity: 2, body: 'The second image is above the fold too.' } };
    return { pr, all: [...threads, draft] };
  };

  it('with no calls, asks the agent to go through each finding with you', async () => {
    const { pr, all } = await findings();
    const prompt = resolvePrompt(pr, all, {});
    expect(prompt).toContain('There are 3.');
    expect(prompt).toContain('I haven’t decided any of these.');
    expect(prompt.match(/My call: Not decided yet\. Ask me\./g)).toHaveLength(3);
    expect(prompt).toContain('review thread T_58_1');
    expect(prompt).toContain('not on GitHub, so there’s no thread to reply to');
  });

  it('carries your calls, fixes only those marked Fix, and closes each GitHub thread', async () => {
    const { pr, all } = await findings();
    const prompt = resolvePrompt(pr, all, { T_58_1: 'fix', T_58_2: 'skip', A_1: 'discuss' });
    expect(prompt).toContain('1. P1 · src/components/CaseImage.tsx:14');
    expect(prompt).toContain('My call: Fix it.');
    expect(prompt).toContain('My call: Not an issue. Don’t change the code.');
    expect(prompt).toContain('Then ask me about the ones I haven’t decided or want to discuss');
    expect(prompt).toContain('Fix only the findings I say to fix');
    expect(prompt).toContain('resolveReviewThread');
  });

  it('takes a thread with no severity and no line, like an unmarked nit on a line that’s gone', async () => {
    const { pr, all } = await findings();
    const t = all.find((f) => f.kind === 'thread')!;
    const plain: Finding = t.kind === 'thread' ? { kind: 'thread', thread: { ...t.thread, severity: null, line: null } } : t;
    const prompt = resolvePrompt(pr, [plain], {});
    expect(prompt).toContain('1. src/components/CaseImage.tsx · review thread T_58_1');
  });

  it('leaves out the GitHub steps when no finding is on GitHub', async () => {
    const { pr, all } = await findings();
    const prompt = resolvePrompt(pr, all.filter((f) => f.kind === 'draft'), { A_1: 'fix' });
    expect(prompt).toContain('There is 1.');
    expect(prompt).not.toContain('gh api graphql');
  });
});

describe('workRules', () => {
  it('says which branch, to keep out of your checkout, and to stop on a failure', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 58, null);
    const rules = workRules(pr, '/Users/me/repos/portfolio').join('\n');
    expect(rules).toContain('Commit the fixes to claude/lazy-images as new commits.');
    expect(rules).toContain('Don’t use my checkout at /Users/me/repos/portfolio');
    expect(rules).toContain('Use a worktree beside it, e.g. /Users/me/repos/portfolio-pr-58.');
    expect(rules).toContain('Stop and tell me if a git command fails. Don’t push until I agree.');
    expect(rules.split('\n')).toHaveLength(4);
  });

  it('asks for a fresh clone when the repo isn’t open here', async () => {
    const pr = await new SampleSource().getPr('calebksmith/portfolio', 58, null);
    const rules = workRules(pr, null).join('\n');
    expect(rules).toContain('isn’t checked out on my machine. Clone it into a new folder');
    expect(rules).not.toContain('null');
  });
});
