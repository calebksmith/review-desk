import type { CheckRun, ConversationItem, PrDetail } from './protocol';
import { isDependabot } from './status';

// Prompts "Fix with agent" hands to the reviewer's AI agent. Short on purpose: what failed, where, and the
// two rules that protect the reviewer (a separate worktree, nothing pushed without a yes). Anything else,
// like the PR's description, the agent can read from the link.

/** Where the prompt went: a new Claude Code session, VS Code's chat, or the clipboard. */
export type AgentRoute = 'claudeCode' | 'chat' | 'clipboard';

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'];
const RULES = 'Work in a separate git worktree on that branch, and don’t push until I agree.';

function header(repo: string, pr: PrDetail): string[] {
  return [`PR: ${repo}#${pr.number} "${pr.title}"${pr.url ? ` ${pr.url}` : ''}`, `Branch: ${pr.headRef}`];
}

export function fixPrompt(pr: PrDetail, run: CheckRun): string {
  const repo = pr.repo;
  const others = pr.checkRuns.filter((r) => r !== run && r.status === 'completed' && FAILED.includes(r.conclusion ?? '')).map((r) => r.name);
  const lines = [
    `The "${run.name}" check is failing${run.failedStep ? ` at "${run.failedStep}"` : ''}. Find the cause and propose a fix.`,
    ...header(repo, pr),
    ...(run.excerpt?.length ? ['', '```', ...run.excerpt, '```'] : run.summary ? ['', run.summary] : []),
    ...(run.url ? [`Log: ${run.url}`] : []),
    ...(others.length ? [`Also failing: ${others.join(', ')}`] : []),
    '',
    RULES,
  ];
  if (isDependabot(pr)) {
    // Review Desk can post Dependabot's ignore commands, so ask for a pick rather than a dependabot.yml edit.
    lines.push('This is a Dependabot update. If the update itself is the problem, say whether to fix around it or ignore it (this version, or the dependency); I’ll ignore it from Review Desk.');
  }
  return lines.join('\n');
}

/** A review comment on a line of code (Codex's findings arrive this way) as a prompt to act on. */
export function threadPrompt(pr: PrDetail, thread: Extract<ConversationItem, { kind: 'thread' }>): string {
  const repo = pr.repo;
  return [
    `Address this review comment on ${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.outdated ? ' (made on an older version of the file)' : ''}.`,
    ...header(repo, pr),
    '',
    ...thread.comments.flatMap((c) => c.text.trim().split('\n').map((l, i) => `> ${i === 0 ? `${c.author}: ` : ''}${l}`)),
    '',
    `Tell me if the comment is right. If it is, propose the change and a one-line reply for the thread. ${RULES}`,
  ].join('\n');
}

/** Conflicts with the base branch: Update branch can't fix these, so the agent merges the base in. */
export function conflictPrompt(pr: PrDetail): string {
  const repo = pr.repo;
  return [
    `This PR has merge conflicts with ${pr.baseRef}. Merge ${pr.baseRef} into the branch, resolve the conflicts, and show me how you resolved each one.`,
    ...header(repo, pr),
    '',
    `Keep what the PR intends and what ${pr.baseRef} changed since; ask me where they truly disagree. ${RULES}`,
  ].join('\n');
}
