import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { excludeLocally } from '../src/gitExclude';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('excludeLocally', () => {
  it('adds the entry once to the local excludes, so git ignores it without a .gitignore change', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rd-'));
    git(repo, 'init', '-q');
    expect(await excludeLocally(repo, '.review-desk/', 'Review Desk')).toBe(true);
    expect(await excludeLocally(repo, '.review-desk/', 'Review Desk')).toBe(true);
    const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8');
    expect(exclude.match(/^\.review-desk\/$/gm)).toHaveLength(1);
    writeFileSync(join(repo, 'a.txt'), 'x');
    execFileSync('mkdir', ['-p', join(repo, '.review-desk')]);
    writeFileSync(join(repo, '.review-desk/f.json'), '[]');
    expect(git(repo, 'status', '--porcelain')).toBe('?? a.txt\n');
  });

  it('finds the excludes file of a worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rd-'));
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const wt = join(mkdtempSync(join(tmpdir(), 'rd-wt-')), 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(await excludeLocally(wt, '.review-desk/', 'Review Desk')).toBe(true);
    execFileSync('mkdir', ['-p', join(wt, '.review-desk')]);
    writeFileSync(join(wt, '.review-desk/f.json'), '[]');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('does nothing outside a git repo', async () => {
    expect(await excludeLocally(mkdtempSync(join(tmpdir(), 'rd-')), '.review-desk/', 'x')).toBe(false);
  });
});
