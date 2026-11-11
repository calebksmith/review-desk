import type { CheckRun, ConversationItem, Decision, Draft, PrDetail } from './protocol';
import { isDependabot } from './status';

// Prompts "Fix with agent" hands to the reviewer's AI agent. Short on purpose: what failed, where, and the
// two rules that protect the reviewer (a separate worktree, nothing pushed without a yes). Anything else,
// like the PR's description, the agent can read from the link.

/** Where the prompt went: a new Claude Code session, VS Code's chat, or the clipboard. */
export type AgentRoute = 'claudeCode' | 'chat' | 'clipboard';

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'];
/**
 * Where an agent that changes code works: new commits on the PR's branch, in a worktree beside your checkout so
 * it never switches the branch you have checked out or touches your uncommitted work. The goal and the limits,
 * not the git commands. `root` is the repo's checkout on this machine, if it's open in VS Code.
 */
export function workRules(pr: PrDetail, root: string | null): string[] {
  return [
    'Where to work:',
    `- Commit the fixes to ${pr.headRef} as new commits.`,
    root
      ? `- Don’t use my checkout at ${root}: it may be on another branch or hold my own work. Use a worktree beside it, e.g. ${root}-pr-${pr.number}.`
      : '- This repo isn’t checked out on my machine. Clone it into a new folder and work there.',
    '- Stop and tell me if a git command fails. Don’t push until I agree.',
  ];
}

function header(repo: string, pr: PrDetail): string[] {
  return [`PR: ${repo}#${pr.number} "${pr.title}"${pr.url ? ` ${pr.url}` : ''}`, `Branch: ${pr.headRef}`];
}

export function fixPrompt(pr: PrDetail, run: CheckRun, root: string | null = null): string {
  const repo = pr.repo;
  const others = pr.checkRuns.filter((r) => r !== run && r.status === 'completed' && FAILED.includes(r.conclusion ?? '')).map((r) => r.name);
  const lines = [
    `The "${run.name}" check is failing${run.failedStep ? ` at "${run.failedStep}"` : ''}. Find the cause and propose a fix.`,
    ...header(repo, pr),
    ...(run.excerpt?.length ? ['', '```', ...run.excerpt, '```'] : run.summary ? ['', run.summary] : []),
    ...(run.url ? [`Log: ${run.url}`] : []),
    ...(others.length ? [`Also failing: ${others.join(', ')}`] : []),
    '',
    ...workRules(pr, root),
  ];
  if (isDependabot(pr)) {
    // Review Desk can post Dependabot's ignore commands, so ask for a pick rather than a dependabot.yml edit.
    lines.push('This is a Dependabot update. If the update itself is the problem, say whether to fix around it or ignore it (this version, or the dependency); I’ll ignore it from Review Desk.');
  }
  return lines.join('\n');
}

/** A review comment on a line of code (Codex's findings arrive this way) as a prompt to act on. */
export function threadPrompt(pr: PrDetail, thread: Extract<ConversationItem, { kind: 'thread' }>, root: string | null = null): string {
  const repo = pr.repo;
  return [
    `Address this review comment on ${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.outdated ? ' (made on an older version of the file)' : ''}.`,
    ...header(repo, pr),
    '',
    ...thread.comments.flatMap((c) => c.text.trim().split('\n').map((l, i) => `> ${i === 0 ? `${c.author}: ` : ''}${l}`)),
    '',
    'Tell me if the comment is right. If it is, propose the change and a one-line reply for the thread.',
    '',
    ...workRules(pr, root),
  ].join('\n');
}

/** Conflicts with the base branch: Update branch can't fix these, so the agent merges the base in. */
export function conflictPrompt(pr: PrDetail, root: string | null = null): string {
  const repo = pr.repo;
  return [
    `This PR has merge conflicts with ${pr.baseRef}. Merge ${pr.baseRef} into the branch, resolve the conflicts, and show me how you resolved each one.`,
    ...header(repo, pr),
    '',
    `Keep what the PR intends and what ${pr.baseRef} changed since; ask me where they truly disagree.`,
    '',
    ...workRules(pr, root),
  ].join('\n');
}

/** A finding for the resolve session: a review thread on GitHub, or a suggestion from your agent's own review. */
export type Finding =
  | { kind: 'thread'; thread: Extract<ConversationItem, { kind: 'thread' }> }
  | { kind: 'draft'; draft: Draft };

const CALL: Record<Decision | 'none', string> = {
  fix: 'Fix it.',
  skip: 'Not an issue. Don’t change the code.',
  discuss: 'Discuss it with me before deciding.',
  none: 'Not decided yet. Ask me.',
};

/**
 * Every open finding on your PR (or your agent's) as one agent session, with your call on each. Undecided
 * ones are asked about, so sending with no calls at all means "go through them with me". Once the push is
 * agreed, the agent replies on each GitHub thread and resolves it, so Review Desk sees the result on refresh.
 */
export function resolvePrompt(pr: PrDetail, findings: readonly Finding[], decisions: Readonly<Record<string, Decision>>, root: string | null = null): string {
  const call = (id: string) => decisions[id] ?? 'none';
  const ask = findings.filter((f) => ['none', 'discuss'].includes(call(f.kind === 'thread' ? f.thread.id : f.draft.id))).length;
  const items = findings.flatMap((f, i) => {
    const t = f.kind === 'thread' ? f.thread : null;
    const d = f.kind === 'draft' ? f.draft : null;
    // A thread's own values, even when they're null (unmarked, or on a line the diff no longer has).
    const { id, path, line } = t ?? d!;
    const sev = t ? t.severity : d!.severity ?? null;
    const where = t ? `review thread ${t.id}` : 'from my agent’s earlier review, not on GitHub, so there’s no thread to reply to';
    const said = t ? t.comments.flatMap((c) => c.text.trim().split('\n').map((l, j) => `   > ${j === 0 ? `${c.author}: ` : ''}${l}`)) : d!.body.trim().split('\n').map((l) => `   > ${l}`);
    return [`${i + 1}. ${sev != null ? `P${sev} · ` : ''}${path}${line ? `:${line}` : ''} · ${where}`, ...said, `   My call: ${CALL[call(id)]}`, ''];
  });
  const threads = findings.some((f) => f.kind === 'thread');
  return [
    `Resolve the open review findings on this PR in one session. There ${findings.length === 1 ? 'is 1' : `are ${findings.length}`}.`,
    ...header(pr.repo, pr),
    '',
    'Findings:',
    ...items,
    'How to go about it:',
    ask === findings.length
      ? '1. I haven’t decided any of these. Start with a short list: each finding, whether you think it’s right, and what you’d do, in a line. Then ask me about each one, one at a time, before changing any code.'
      : `1. Start with a short list: each finding, whether you think it’s right, and what you’d do, in a line.${ask ? ' Then ask me about the ones I haven’t decided or want to discuss, one at a time, before changing any code.' : ''}`,
    '2. Fix only the findings I say to fix, one commit per finding, working as set out under "Where to work". Don’t push until I agree; when you ask, include the reply you’ll post on each thread.',
    ...(threads ? ['3. Once I agree and you’ve pushed, close each review thread: reply with what you did ("Fixed in <short sha>: …" or "Not an issue: …"), then resolve it. Leave threads we decided to keep open alone.'] : []),
    '',
    ...workRules(pr, root),
    // Replying in a thread and resolving it need GitHub's GraphQL API; gh's everyday commands can't do either.
    ...(threads ? [
      '',
      'For step 3 (gh pr comment can’t reply in a thread or resolve it):',
      `gh api graphql -f query='mutation($t: ID!, $b: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $t, body: $b}) { comment { url } } }' -f t=THREAD_ID -f b='REPLY'`,
      `gh api graphql -f query='mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t=THREAD_ID`,
    ] : []),
  ].join('\n');
}
