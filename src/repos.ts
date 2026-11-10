import { parseRemote } from './remote';
import type { Scope } from './scope';

/** The parts of a VS Code git repository this module reads. */
export interface GitRepoLike {
  state: { remotes: { name: string; fetchUrl?: string; pushUrl?: string }[] };
}

/** owner/name for each open git repo with a GitHub remote, preferring `origin`, without duplicates. */
export function githubRepos(repos: readonly GitRepoLike[]): string[] {
  const found: string[] = [];
  for (const repo of repos) {
    const remotes = [...repo.state.remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
    for (const remote of remotes) {
      const parsed = parseRemote(remote.fetchUrl ?? remote.pushUrl ?? '');
      if (parsed) {
        if (!found.includes(parsed)) found.push(parsed);
        break;
      }
    }
  }
  return found;
}

/** What the workspace remembers when the reviewer picked "Everything that involves you". */
export const EVERYTHING_PICK = '*';

/**
 * What to review without asking: a repo pinned in settings, then the reviewer's last pick in this workspace,
 * then everything that involves them (plus the repos they always want in full).
 */
export function defaultScope(configured: string, remembered: string | undefined, full: readonly string[]): Scope {
  if (configured.trim()) return { kind: 'repo', repo: configured.trim() };
  if (remembered && remembered !== EVERYTHING_PICK) return { kind: 'repo', repo: remembered };
  return { kind: 'involves', full: [...full] };
}

/** owner/name from what a reviewer typed: owner/name or a github.com URL. Null if it's neither. */
export function parseRepositoryInput(input: string): string | null {
  const text = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text.replace(/\.git$/, '');
  return parseRemote(text);
}
