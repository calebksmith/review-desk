import { describe, expect, it } from 'vitest';
import { defaultScope, githubRepos, parseRepositoryInput } from '../src/repos';

const repo = (...remotes: [string, string][]) => ({ state: { remotes: remotes.map(([name, fetchUrl]) => ({ name, fetchUrl })) } });

describe('githubRepos', () => {
  it('lists every open repo with a GitHub remote, in order', () => {
    const repos = [repo(['origin', 'https://github.com/acme/api.git']), repo(['origin', 'git@github.com:acme/web.git'])];
    expect(githubRepos(repos)).toEqual(['acme/api', 'acme/web']);
  });

  it('prefers origin over other remotes', () => {
    expect(githubRepos([repo(['upstream', 'https://github.com/acme/web.git'], ['origin', 'https://github.com/me/web.git'])])).toEqual(['me/web']);
  });

  it('falls back to another GitHub remote and skips repos with none', () => {
    const repos = [repo(['origin', 'https://gitlab.com/acme/x.git'], ['mirror', 'https://github.com/acme/x.git']), repo(['origin', 'https://gitlab.com/acme/y.git']), repo()];
    expect(githubRepos(repos)).toEqual(['acme/x']);
  });

  it('lists a repo once when two folders share it', () => {
    expect(githubRepos([repo(['origin', 'https://github.com/acme/web.git']), repo(['origin', 'https://github.com/acme/web'])])).toEqual(['acme/web']);
  });
});

describe('defaultScope', () => {
  it('uses a repo pinned in settings first', () => {
    expect(defaultScope(' acme/pinned ', 'acme/last', [])).toEqual({ kind: 'repo', repo: 'acme/pinned' });
  });

  it('then the last pick in this workspace', () => {
    expect(defaultScope('', 'acme/last', [])).toEqual({ kind: 'repo', repo: 'acme/last' });
    expect(defaultScope('', '*', ['acme/web'])).toEqual({ kind: 'involves', full: ['acme/web'] });
  });

  it('otherwise everything that involves you, plus the repos shown in full', () => {
    expect(defaultScope('', undefined, ['acme/web'])).toEqual({ kind: 'involves', full: ['acme/web'] });
  });
});

describe('parseRepositoryInput', () => {
  it.each([
    ['acme/web', 'acme/web'],
    ['  acme/web.git ', 'acme/web'],
    ['my-org/site.io', 'my-org/site.io'],
    ['https://github.com/acme/web', 'acme/web'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['acme', null],
    ['acme/web/extra', null],
    ['https://gitlab.com/acme/web', null],
  ])('%s', (input, expected) => expect(parseRepositoryInput(input)).toBe(expected));
});
