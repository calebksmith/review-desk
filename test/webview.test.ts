import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The webview builds HTML in template strings, so a stray quote breaks a button without any type error.
describe('webview markup', () => {
  const src = readFileSync(new URL('../webview/main.ts', import.meta.url), 'utf8');
  it('has no attribute with a doubled quote before its value', () => {
    expect(src.match(/\s[\w-]+=""\$\{/g) ?? []).toEqual([]);
  });

  // The webview's CSP has no 'unsafe-inline', so VS Code drops style attributes. Layout values go in data-vars.
  it('sets no style attributes in markup', () => {
    expect(src.match(/\sstyle="/g) ?? []).toEqual([]);
  });
});

// VS Code's GitHub sign-in grants the "repo" scope only. Team fields need read:org, and asking for one
// fails every query.
describe('GitHub queries', () => {
  const src = readFileSync(new URL('../src/github.ts', import.meta.url), 'utf8');
  it('ask for no team fields, which the repo scope can’t read', () => {
    expect(src.match(/\.\.\. on Team \{/g) ?? []).toEqual([]);
  });
});
