import type { PrSummary } from './protocol';

// Stacked PRs: a PR whose base branch is another open PR's branch is stacked on it, and merges after it.

const open = (queue: readonly PrSummary[]) => queue.filter((p) => p.state === 'open');

/** The open PR this one is stacked on, or null when it merges into a normal branch. */
export function parentOf(pr: Pick<PrSummary, 'baseRef' | 'number'>, queue: readonly PrSummary[]): PrSummary | null {
  return open(queue).find((p) => p.headRef === pr.baseRef && p.number !== pr.number) ?? null;
}

export function childrenOf(pr: Pick<PrSummary, 'headRef' | 'number'>, queue: readonly PrSummary[]): PrSummary[] {
  return open(queue).filter((p) => p.baseRef === pr.headRef && p.number !== pr.number).sort((a, b) => a.number - b.number);
}

export interface StackRow { pr: PrSummary; depth: number }

/** Every PR in the stack under `root`, in merge order (parents before children), with its depth. */
function walk(root: PrSummary, queue: readonly PrSummary[], depth = 0, seen = new Set<number>()): StackRow[] {
  if (seen.has(root.number)) return [];
  seen.add(root.number);
  return [{ pr: root, depth }, ...childrenOf(root, queue).flatMap((c) => walk(c, queue, depth + 1, seen))];
}

/** The whole stack a PR belongs to, from its bottom PR up. Just the PR itself when it isn't stacked. */
export function stackOf(pr: PrSummary, queue: readonly PrSummary[]): StackRow[] {
  let root = queue.find((p) => p.number === pr.number) ?? pr;
  const seen = new Set<number>([root.number]);
  for (let up = parentOf(root, queue); up && !seen.has(up.number); up = parentOf(up, queue)) { seen.add(up.number); root = up; }
  return walk(root, queue);
}

/** Open PRs split into stacks (two or more PRs, bottom PR first) and the PRs that stand alone. */
export function stacks(queue: readonly PrSummary[]): { stacks: StackRow[][]; alone: PrSummary[] } {
  const roots = open(queue).filter((p) => !parentOf(p, queue));
  const all = roots.map((r) => walk(r, queue));
  return { stacks: all.filter((s) => s.length > 1), alone: all.filter((s) => s.length === 1).map((s) => s[0]!.pr) };
}
