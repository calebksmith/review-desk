import type { ConversationItem, Draft, PrDetail } from './protocol';

// "Review with agent": an independent, adversarial review by the reviewer's own agent. Its findings come
// back through a JSON file Review Desk watches, and land as drafts the reviewer keeps, edits or drops.

/**
 * Where an agent writes its findings for a PR, relative to the repo's root. Ignored by git (local excludes).
 * Owner and repo are joined by "__": GitHub owners can't contain "_", so the name reads back unambiguously
 * even when both have hyphens ("my-org__web-app-102.json").
 */
export const findingsPath = (repo: string, number: number) => `.review-desk/${repo.replace('/', '__')}-${number}.json`;

/** The PR a findings file is about, from its name; null for any other file. */
export function findingsFor(fileName: string): { repo: string; number: number } | null {
  const m = /^([A-Za-z0-9-]+)__([\w.-]+)-(\d+)\.json$/.exec(fileName.split(/[\\/]/).pop() ?? '');
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

type Thread = Extract<ConversationItem, { kind: 'thread' }>;

export function reviewPrompt(pr: PrDetail, file: string | null): string {
  const known = pr.conversation.filter((it): it is Thread => it.kind === 'thread' && !it.resolved);
  const body = pr.body.trim();
  return [
    'Do an independent, adversarial review of this pull request. Don’t change any code.',
    `PR: ${pr.repo}#${pr.number} "${pr.title}"${pr.url ? ` ${pr.url}` : ''}`,
    `Branch: ${pr.headRef} → ${pr.baseRef}`,
    ...(body ? ['', 'What it says it does:', body.length > 600 ? `${body.slice(0, 600)}…` : body] : []),
    ...(known.length ? ['', 'Already flagged (don’t repeat these):', ...known.map((t) => `- ${t.path}${t.line ? `:${t.line}` : ''}${t.severity != null ? ` P${t.severity}` : ''} ${firstLine(t.comments[0]?.text ?? '')}`)] : []),
    '',
    'Look hardest at what automated review misses: whether the change does what the description says, security, data loss and migrations, concurrency and retries, error handling, and tests that don’t really test the change.',
    `Work in a separate git worktree on ${pr.headRef}.`,
    '',
    file ? `When you’re done, write your findings as JSON to ${file}:` : 'When you’re done, reply with your findings as JSON:',
    '[{ "path": "src/a.ts", "line": 12, "severity": 1, "title": "Short title", "body": "What’s wrong, why it matters, and how to fix it" }]',
    'Severity: 0 must be fixed before merging (security, data loss), 1 should be fixed before merging, 2 worth fixing, 3 a nit. "line" is the line in the new version of the file; pick a line this PR changed when you can. Write [] if you find nothing.',
  ].join('\n');
}

/** A finding's gist for the prompt, without the P0–P3 marker it starts with (the list already gives it). */
const firstLine = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/^\**P[0-3]\**\s*/, '').slice(0, 120);

/**
 * An agent's findings as drafts marked "from your agent". Anything that isn't a finding on a file of this
 * PR is dropped, so a stray or malformed file can't post nonsense.
 */
export function parseFindings(raw: unknown, pr: Pick<PrDetail, 'files'>, newId: () => string): Draft[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { findings?: unknown }).findings) ? (raw as { findings: unknown[] }).findings : [];
  const paths = new Set(pr.files.map((f) => f.path));
  const out: Draft[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const { path, line, severity, title, body } = f as Record<string, unknown>;
    if (typeof path !== 'string' || !paths.has(path)) continue;
    const text = [typeof title === 'string' ? title.trim() : '', typeof body === 'string' ? body.trim() : ''].filter(Boolean).join('\n\n');
    if (!text) continue;
    const sev = typeof severity === 'number' && severity >= 0 && severity <= 3 ? Math.round(severity) : null;
    out.push({
      id: newId(), path, line: typeof line === 'number' && line > 0 ? Math.round(line) : null, side: 'RIGHT',
      body: sev != null ? `**P${sev}** ${text}` : text, from: 'agent', severity: sev,
    });
  }
  return out;
}
