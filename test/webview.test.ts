import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The webview builds HTML in template strings, so a stray quote breaks a button without any type error.
describe('webview markup', () => {
  const src = readFileSync(new URL('../webview/main.ts', import.meta.url), 'utf8');
  it('has no attribute with a doubled quote before its value', () => {
    expect(src.match(/\s[\w-]+=""\$\{/g) ?? []).toEqual([]);
  });
});
