import { parseRemote } from './remote';

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

/**
 * Which repo Open should review without asking: the setting, then the reviewer's last pick in this
 * workspace, then the only GitHub repo open. Null means the reviewer has to choose.
 */
export function defaultRepository(configured: string, remembered: string | undefined, candidates: readonly string[]): string | null {
  if (configured.trim()) return configured.trim();
  if (remembered) return remembered;
  return candidates.length === 1 ? candidates[0]! : null;
}

/** owner/name from what a reviewer typed: owner/name or a github.com URL. Null if it's neither. */
export function parseRepositoryInput(input: string): string | null {
  const text = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text.replace(/\.git$/, '');
  return parseRemote(text);
}
