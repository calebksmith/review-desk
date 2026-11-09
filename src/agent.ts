import type { CheckRun, ConversationItem, PrDetail } from './protocol';
import { isDependabot } from './status';

// The prompt "Fix with agent" hands to the reviewer's AI agent: everything it needs to diagnose a
// failing check without the reviewer copying anything, and a plan that asks before it pushes.

/** Where the prompt went: a new Claude Code session, VS Code's chat, or the clipboard. */
export type AgentRoute = 'claudeCode' | 'chat' | 'clipboard';

const MAX_BODY = 2000;
const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'];

export function fixPrompt(repo: string, pr: PrDetail, run: CheckRun): string {
  const others = pr.checkRuns.filter((r) => r !== run && r.status === 'completed' && FAILED.includes(r.conclusion ?? ''));
  const body = pr.body.trim();
  const lines = [
    'Diagnose and fix a failing check on a pull request.',
    '',
    `Repository: ${repo}`,
    `Pull request: #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ''}`,
    `Branch: ${pr.headRef} → ${pr.baseRef}, head commit ${pr.headSha.slice(0, 7)}`,
    `Author: ${pr.author}`,
    '',
    `Failing check: ${run.name}${run.app ? ` (${run.app})` : ''}`,
    ...(run.failedStep ? [`Failed step: ${run.failedStep}`] : []),
    ...(run.summary ? [`Summary: ${run.summary}`] : []),
    ...(run.url ? [`Log: ${run.url}`] : []),
    ...(run.excerpt?.length ? ['Error lines from the log:', '```', ...run.excerpt, '```'] : []),
    ...(others.length ? ['', `Also failing on this PR: ${others.map((r) => (r.failedStep ? `${r.name} (at "${r.failedStep}")` : r.name)).join(', ')}`] : []),
    '',
    'What the PR says it does:',
    body ? (body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body) : '(no description)',
    '',
    'Please:',
    `1. Work on branch ${pr.headRef} in a separate git worktree, so my current work isn't touched.`,
    '2. Reproduce the failure by running the failed step locally.',
    '3. Tell me the cause in a few sentences and propose a fix. Don’t push until I agree.',
    `4. Once I agree, commit the fix to ${pr.headRef}, push it, and tell me which check to watch.`,
  ];
  if (isDependabot(pr)) {
    lines.push(
      '',
      'This PR is from Dependabot. If the update itself is the problem, compare: updating related packages so they work with the new version, holding the update back, or closing the PR and adding an ignore rule for this version in .github/dependabot.yml. Pushing to a Dependabot branch stops Dependabot from rebasing it, so say so if you recommend that.',
    );
  }
  return lines.join('\n');
}

/** A review comment on a line of code (Codex's findings arrive this way) as a prompt to act on. */
export function threadPrompt(repo: string, pr: PrDetail, thread: Extract<ConversationItem, { kind: 'thread' }>): string {
  return [
    'Address a review comment on a pull request.',
    '',
    `Repository: ${repo}`,
    `Pull request: #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ''}`,
    `Branch: ${pr.headRef} → ${pr.baseRef}, head commit ${pr.headSha.slice(0, 7)}`,
    '',
    `File: ${thread.path}${thread.line ? `, line ${thread.line}` : ''}${thread.outdated ? ' (the comment is on an older version of the file)' : ''}`,
    'The comment thread, oldest first:',
    ...thread.comments.flatMap((c) => ['', `${c.author} wrote:`, ...c.text.trim().split('\n').map((l) => `> ${l}`)]),
    '',
    'Please:',
    `1. Work on branch ${pr.headRef} in a separate git worktree, so my current work isn't touched.`,
    '2. Read the code the comment points at and tell me whether the comment is right, in a few sentences.',
    '3. If it is, propose the change. Don’t push until I agree.',
    `4. Once I agree, commit to ${pr.headRef}, push, and draft a short reply to the thread saying what changed.`,
  ].join('\n');
}
