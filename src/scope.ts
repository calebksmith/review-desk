import { prKey, type PrSummary } from './protocol';

// What the queue covers: one repo, or everything that involves the reviewer across GitHub
// plus repos they always want in full.

export type Scope = { kind: 'involves'; full: string[] } | { kind: 'repo'; repo: string };

export const EVERYTHING = 'Everything involving you';

export function scopeLabel(s: Scope): string {
  if (s.kind === 'repo') return s.repo;
  return s.full.length ? `${EVERYTHING} + ${s.full.length === 1 ? s.full[0] : `${s.full.length} repos`}` : EVERYTHING;
}

/**
 * GitHub searches for "involves me": involves: covers author, assignee, mentions and comments, but not review
 * requests or reviews, so those get their own. Merged ones are limited to the last week.
 */
export function searchQueries(since: Date): { open: string[]; merged: string } {
  const base = 'is:pr archived:false';
  return {
    open: [`${base} is:open involves:@me`, `${base} is:open review-requested:@me`, `${base} is:open reviewed-by:@me`],
    merged: `${base} is:merged involves:@me merged:>=${since.toISOString().slice(0, 10)}`,
  };
}

/** One queue from several lists, each PR once (by repo and number), most recently updated first. */
export function combine(lists: PrSummary[][]): PrSummary[] {
  const byKey = new Map<string, PrSummary>();
  for (const p of lists.flat()) {
    const seen = byKey.get(prKey(p));
    if (!seen || Date.parse(p.updatedAt) > Date.parse(seen.updatedAt)) byKey.set(prKey(p), p);
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
