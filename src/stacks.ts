import { prKey, type PrSummary } from './protocol';

// Stacked PRs: a PR whose base branch is another open PR's branch is stacked on it, and merges after it.

const open = (queue: readonly PrSummary[]) => queue.filter((p) => p.state === 'open');

/** The open PR this one is stacked on, or null when it merges into a normal branch. */
export function parentOf(pr: Pick<PrSummary, 'repo' | 'baseRef' | 'number'>, queue: readonly PrSummary[]): PrSummary | null {
  return open(queue).find((p) => p.repo === pr.repo && p.headRef === pr.baseRef && p.number !== pr.number) ?? null;
}

export function childrenOf(pr: Pick<PrSummary, 'repo' | 'headRef' | 'number'>, queue: readonly PrSummary[]): PrSummary[] {
  return open(queue).filter((p) => p.repo === pr.repo && p.baseRef === pr.headRef && p.number !== pr.number).sort((a, b) => a.number - b.number);
}

export interface StackRow { pr: PrSummary; depth: number }

/** Every PR in the stack under `root`, in merge order (parents before children), with its depth. */
function walk(root: PrSummary, queue: readonly PrSummary[], depth = 0, seen = new Set<string>()): StackRow[] {
  if (seen.has(prKey(root))) return [];
  seen.add(prKey(root));
  return [{ pr: root, depth }, ...childrenOf(root, queue).flatMap((c) => walk(c, queue, depth + 1, seen))];
}

/** The whole stack a PR belongs to, from its bottom PR up. Just the PR itself when it isn't stacked. */
export function stackOf(pr: PrSummary, queue: readonly PrSummary[]): StackRow[] {
  let root = queue.find((p) => prKey(p) === prKey(pr)) ?? pr;
  const seen = new Set<string>([prKey(root)]);
  for (let up = parentOf(root, queue); up && !seen.has(prKey(up)); up = parentOf(up, queue)) { seen.add(prKey(up)); root = up; }
  return walk(root, queue);
}

/** Open PRs split into stacks (two or more PRs, bottom PR first) and the PRs that stand alone. */
export function stacks(queue: readonly PrSummary[]): { stacks: StackRow[][]; alone: PrSummary[] } {
  const roots = open(queue).filter((p) => !parentOf(p, queue));
  const all = roots.map((r) => walk(r, queue));
  return { stacks: all.filter((s) => s.length > 1), alone: all.filter((s) => s.length === 1).map((s) => s[0]!.pr) };
}

/** One row of a merge tree, drawn like a git graph: where its dot sits and which lines pass by or join it. */
export interface TreeRow {
  pr: PrSummary;
  /** The column of this PR's dot. */
  lane: number;
  /** A PR above continues straight down into this dot. */
  up: boolean;
  /** Columns whose lines run the full height of this row, on their way down to a PR further below. */
  through: number[];
  /** Columns of PRs above whose lines curve into this dot (the second and later branches of a fork). */
  joins: number[];
}

/**
 * A stack as a merge tree, top to bottom: the newest PRs at the top, each above the PR it's stacked on, and
 * the bottom PR (merges first) last, just above its base branch. The first PR stacked on another keeps its
 * column; each further one gets a new column and curves back in, like a git graph. `lanes` is the width.
 */
export function mergeTree(rows: StackRow[], queue: readonly PrSummary[]): { rows: TreeRow[]; lanes: number } {
  if (!rows.length) return { rows: [], lanes: 0 };
  const inStack = new Set(rows.map((r) => prKey(r.pr)));
  const kids = (pr: PrSummary) => childrenOf(pr, queue).filter((c) => inStack.has(prKey(c)));
  const lane = new Map<string, number>();
  let next = 1;
  const assign = (pr: PrSummary, l: number) => {
    lane.set(prKey(pr), l);
    kids(pr).forEach((c, i) => assign(c, i === 0 ? l : next++));
  };
  const root = rows[0]!.pr;
  assign(root, 0);

  // Post-order, later branches first: every PR lands above the one it's stacked on.
  const order: PrSummary[] = [];
  const visit = (pr: PrSummary) => { [...kids(pr)].reverse().forEach(visit); order.push(pr); };
  visit(root);

  const at = new Map(order.map((p, i) => [prKey(p), i]));
  const out: TreeRow[] = order.map((pr) => ({ pr, lane: lane.get(prKey(pr))!, up: false, through: [], joins: [] }));
  for (const pr of order) {
    for (const c of kids(pr)) {
      const from = at.get(prKey(c))!;
      const to = at.get(prKey(pr))!;
      const l = lane.get(prKey(c))!;
      for (let r = from + 1; r < to; r++) out[r]!.through.push(l);
      if (l === lane.get(prKey(pr))) out[to]!.up = true;
      else out[to]!.joins.push(l);
    }
  }
  return { rows: out, lanes: next };
}
