import { describe, expect, it } from 'vitest';
import { closeOptions, parseBump } from '../src/dependabot';
import type { PrSummary } from '../src/protocol';

const pr = (title: string) => ({ title }) as PrSummary;

describe('parseBump', () => {
  it.each([
    ['Bump typescript from 5.9.3 to 7.0.2', { dependency: 'typescript', from: '5.9.3', to: '7.0.2' }],
    ['build(deps-dev): bump @types/node from 22.20.5 to 25.9.9', { dependency: '@types/node', from: '22.20.5', to: '25.9.9' }],
    ['Bump actions/checkout from v4 to v5', { dependency: 'actions/checkout', from: '4', to: '5' }],
    ['Bump the minor-and-patch group across 1 directory with 13 updates', null],
    ['Bump qs and express', null],
  ])('%s', (title, expected) => expect(parseBump(title)).toEqual(expected));
});

describe('closeOptions', () => {
  it('offers to ignore the new major version first', () => {
    const options = closeOptions(pr('Bump typescript from 5.9.3 to 7.0.2'));
    expect(options.map((o) => o.label)).toEqual(['Ignore typescript 7', 'Ignore typescript entirely', 'Close for now']);
    expect(options[0]!.comment).toBe('@dependabot ignore this major version');
  });

  it('offers the minor version for a minor bump, and nothing narrower for a patch', () => {
    expect(closeOptions(pr('Bump vite from 6.3.1 to 6.4.0'))[0]).toMatchObject({ label: 'Ignore vite 6.4', comment: '@dependabot ignore this minor version' });
    expect(closeOptions(pr('Bump vite from 6.3.1 to 6.3.5')).map((o) => o.comment)).toEqual(['@dependabot ignore this dependency', '@dependabot close']);
  });

  it('only offers Close for grouped updates', () => {
    expect(closeOptions(pr('Bump the minor-and-patch group with 13 updates')).map((o) => o.comment)).toEqual(['@dependabot close']);
  });
});
