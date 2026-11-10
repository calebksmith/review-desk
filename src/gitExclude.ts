import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Adds a path to a repo's local excludes (.git/info/exclude), which git never commits, so it stays out of
 * git without touching the repo's .gitignore. Asks git where that file is, since worktrees keep it elsewhere.
 * Returns false when the folder isn't a git repo or git can't be run; nothing is written then.
 */
export async function excludeLocally(root: string, entry: string, why: string): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root });
    const file = stdout.trim();
    const path = isAbsolute(file) ? file : join(root, file);
    const now = await readFile(path, 'utf8').catch(() => '');
    if (now.split(/\r?\n/).some((l) => l.trim() === entry)) return true;
    await appendFile(path, `${now && !now.endsWith('\n') ? '\n' : ''}# ${why}\n${entry}\n`);
    return true;
  } catch {
    return false;
  }
}
