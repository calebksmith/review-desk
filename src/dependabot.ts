import type { PrSummary } from './protocol';

// Dependabot reads commands from PR comments. These are the ones for closing a PR, worded as choices.
// https://docs.github.com/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates

export interface CloseOption { label: string; detail: string; comment: string }

/** The dependency and versions from a title like "Bump typescript from 5.9.3 to 7.0.2" (any commit prefix). */
export function parseBump(title: string): { dependency: string; from: string; to: string } | null {
  const m = /\bbump (\S+) from v?(\d[\w.+-]*) to v?(\d[\w.+-]*)/i.exec(title);
  return m ? { dependency: m[1]!, from: m[2]!, to: m[3]! } : null;
}

const major = (v: string) => v.split('.')[0]!;
const minor = (v: string) => v.split('.').slice(0, 2).join('.');

/** Ways to close a Dependabot PR. Grouped and multi-package PRs only get "Close": their ignore commands name each package. */
export function closeOptions(pr: PrSummary): CloseOption[] {
  const close: CloseOption = { label: 'Close for now', detail: 'Dependabot may open it again with the next release.', comment: '@dependabot close' };
  const bump = parseBump(pr.title);
  if (!bump) return [close];
  const { dependency: d, from, to } = bump;
  const options: CloseOption[] = [];
  if (major(from) !== major(to)) {
    options.push({ label: `Ignore ${d} ${major(to)}`, detail: `Closes this PR. No more PRs for ${d} ${major(to)}.x; other updates to ${d} still come.`, comment: '@dependabot ignore this major version' });
  } else if (minor(from) !== minor(to)) {
    options.push({ label: `Ignore ${d} ${minor(to)}`, detail: `Closes this PR. No more PRs for ${d} ${minor(to)}.x; other updates to ${d} still come.`, comment: '@dependabot ignore this minor version' });
  }
  options.push({ label: `Ignore ${d} entirely`, detail: `Closes this PR. Dependabot stops updating ${d}.`, comment: '@dependabot ignore this dependency' });
  options.push(close);
  return options;
}
