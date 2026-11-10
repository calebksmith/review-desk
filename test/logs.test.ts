import { describe, expect, it } from 'vitest';
import { logExcerpt } from '../src/logs';

const ts = (lines: string[]) => lines.map((l, i) => `2026-10-11T18:40:${String(10 + i).padStart(2, '0')}.1234567Z ${l}`).join('\n');

describe('logExcerpt', () => {
  it('returns the error lines of the step that failed', () => {
    const log = ts([
      '##[group]Run actions/checkout@v4', 'Syncing repository', '##[endgroup]',
      '##[group]Run npm ci', 'npm ci', 'shell: /usr/bin/bash -e {0}', '##[endgroup]',
      'npm error code ERESOLVE', 'npm error', 'npm error While resolving: plugin@6.10.2',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
    ]);
    expect(logExcerpt(log)).toEqual(['npm error code ERESOLVE', 'npm error While resolving: plugin@6.10.2']);
  });

  it('keeps every error a tool marks, not just the first', () => {
    const log = ts([
      '##[group]Run npm run typecheck', 'npm run typecheck', '##[endgroup]',
      '> app@0.1.0 typecheck', '> tsc --noEmit',
      "##[error]app/layout.tsx(16,57): error TS2304: Cannot find name 'LayoutProps'.",
      "##[error]app/page.tsx(21,4): error TS2304: Cannot find name 'PageProps'.",
      '##[error]Process completed with exit code 2.',
    ]);
    expect(logExcerpt(log)).toEqual([
      "app/layout.tsx(16,57): error TS2304: Cannot find name 'LayoutProps'.",
      "app/page.tsx(21,4): error TS2304: Cannot find name 'PageProps'.",
    ]);
  });

  it('falls back to the last lines when nothing looks like an error', () => {
    const log = ts(['##[group]Run ./deploy.sh', './deploy.sh', '##[endgroup]', 'Uploading', 'Timed out after 30s', '##[error]Process completed with exit code 124.']);
    expect(logExcerpt(log)).toEqual(['Uploading', 'Timed out after 30s']);
  });

  it('strips terminal colors and caps long lines', () => {
    const long = 'x'.repeat(300);
    const log = ts(['##[group]Run make', 'make', '##[endgroup]', `\x1b[31mERROR\x1b[0m ${long}`, '##[error]Process completed with exit code 2.']);
    const [line] = logExcerpt(log)!;
    expect(line!.startsWith('ERROR x')).toBe(true);
    expect(line!.length).toBe(200);
  });

  it('is null for a log with no failure', () => {
    expect(logExcerpt(ts(['##[group]Run npm test', 'npm test', '##[endgroup]', 'All passed']))).toBeNull();
  });
});
