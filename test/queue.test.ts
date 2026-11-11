import { describe, expect, it } from 'vitest';
import type { ConversationItem, DiffLine, Draft, PrDetail } from '../src/protocol';
import { fileMarks, nearLines, openOn, reviewQueue, stepQueue } from '../src/queue';
import { SampleSource } from '../src/sample';

const thread = (id: string, path: string, line: number | null, p: { severity?: number | null; resolved?: boolean } = {}): ConversationItem =>
  ({ kind: 'thread', id, path, line, resolved: p.resolved ?? false, outdated: false, comments: [], severity: p.severity ?? null });
const draft = (id: string, p: Partial<Draft>): Draft => ({ id, path: 'a.ts', line: 1, side: 'RIGHT', body: '', from: 'you', ...p });
const pr = (conversation: ConversationItem[]) => ({ conversation }) as unknown as PrDetail;

describe('reviewQueue', () => {
  it('holds open threads and agent suggestions, most severe first, then by file and line', () => {
    const q = reviewQueue(
      pr([thread('t1', 'b.ts', 9), thread('t2', 'a.ts', 4, { severity: 1 }), thread('t3', 'a.ts', 2, { severity: 1 }), thread('t4', 'c.ts', 1, { resolved: true })]),
      [draft('d1', { from: 'agent', path: 'c.ts', line: 3, severity: 0 })], 'me',
    );
    expect(q.map((x) => x.id)).toEqual(['d1', 't3', 't2', 't1']);
    expect(q[0]).toMatchObject({ kind: 'draft', path: 'c.ts', line: 3, severity: 0 });
  });

  it('leaves out threads you’ve answered and your own drafts', () => {
    const q = reviewQueue(pr([thread('t1', 'a.ts', 1), thread('t2', 'a.ts', 2)]), [draft('r', { replyTo: 't1' }), draft('mine', {})], 'me');
    expect(q.map((x) => x.id)).toEqual(['t2']);
  });

  it('on your own PR, keeps every unresolved thread, even one you (or an agent as you) answered', () => {
    const by = (author: string) => ({ author, createdAt: '', html: '', text: '', url: '', isNew: false });
    const posted = { ...thread('t1', 'a.ts', 1), comments: [by('me')] } as ConversationItem;
    const replied = { ...thread('t2', 'a.ts', 2), comments: [by('me'), by('me')] } as ConversationItem;
    const mine = { conversation: [posted, replied], mine: true } as unknown as PrDetail;
    expect(reviewQueue(mine, [], 'me').map((x) => x.id)).toEqual(['t1', 't2']);
    // On someone else's PR, a thread you started is waiting on its author.
    expect(reviewQueue(pr([posted]), [], 'me')).toEqual([]);
  });

  it('leaves out threads where you wrote the last comment', () => {
    const by = (author: string) => ({ author, createdAt: '', html: '', text: '', url: '', isNew: false });
    const t1 = { ...thread('t1', 'a.ts', 1), comments: [by('codex'), by('me')] } as ConversationItem;
    const t2 = { ...thread('t2', 'a.ts', 2), comments: [by('me'), by('author')] } as ConversationItem;
    expect(reviewQueue(pr([t1, t2]), [], 'me').map((x) => x.id)).toEqual(['t2']);
  });
});

describe('fileMarks', () => {
  it('counts each file’s items and keeps its most severe', () => {
    const q = reviewQueue(pr([thread('t1', 'a.ts', 1), thread('t2', 'a.ts', 2, { severity: 2 }), thread('t3', 'b.ts', 1)]), [], 'me');
    const m = fileMarks(q);
    expect(m.get('a.ts')).toEqual({ count: 2, severity: 2 });
    expect(m.get('b.ts')).toEqual({ count: 1, severity: null });
  });
});

describe('stepQueue', () => {
  const q = reviewQueue(pr([thread('t1', 'a.ts', 1), thread('t2', 'a.ts', 2), thread('t3', 'a.ts', 3)]), [], 'me');
  it('wraps around, and starts at either end with nothing current', () => {
    expect(stepQueue(q, 't3', 1)?.id).toBe('t1');
    expect(stepQueue(q, 't1', -1)?.id).toBe('t3');
    expect(stepQueue(q, null, 1)?.id).toBe('t1');
    expect(stepQueue(q, 'gone', -1)?.id).toBe('t3');
  });
  it('has nowhere to go from the only item', () => {
    expect(stepQueue(q.slice(0, 1), 't1', 1)).toBeNull();
    expect(stepQueue([], null, 1)).toBeNull();
  });
});

describe('nearLines', () => {
  const ctx = (n: number): DiffLine => ({ kind: 'ctx', oldNo: n, newNo: n, text: `${n}` });
  const file: DiffLine[] = Array.from({ length: 30 }, (_, i) => ctx(i + 1));
  const nos = (ls: DiffLine[]) => ls.map((l) => (l.kind === 'gap' ? `gap:${l.hidden}` : l.newNo));

  it('keeps six lines above and three below each comment, with gaps for the rest', () => {
    expect(nos(nearLines(file, [{ side: 'RIGHT', line: 15 }]))).toEqual(['gap:8', 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 'gap:12']);
  });

  it('joins windows that overlap, and clips at the ends', () => {
    expect(nos(nearLines(file, [{ side: 'RIGHT', line: 2 }, { side: 'RIGHT', line: 7 }]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'gap:20']);
  });

  it('matches a left-side comment to the removed line', () => {
    const ls: DiffLine[] = [{ kind: 'del', oldNo: 5, newNo: null, text: 'x' }, { kind: 'add', oldNo: null, newNo: 5, text: 'y' }];
    expect(nearLines(ls, [{ side: 'LEFT', line: 5 }])).toHaveLength(2);
    expect(nearLines([ls[0]!], [{ side: 'RIGHT', line: 5 }])).toEqual([]);
  });

  it('folds existing gaps into the count, or says nothing when one had no count', () => {
    const ls: DiffLine[] = [ctx(1), { kind: 'gap', hidden: 40 }, ...Array.from({ length: 12 }, (_, i) => ctx(i + 50))];
    expect(nos(nearLines(ls, [{ side: 'RIGHT', line: 61 }]))[0]).toBe('gap:46');
    ls[1] = { kind: 'gap', hidden: null };
    expect(nos(nearLines(ls, [{ side: 'RIGHT', line: 61 }]))[0]).toBe('gap:null');
  });

  it('shows nothing for comments on lines the diff doesn’t have', () => {
    expect(nearLines(file, [{ side: 'RIGHT', line: 99 }, { side: 'RIGHT', line: null }])).toEqual([]);
  });
});

describe('openOn', () => {
  const agent: Draft = { id: 'A_58_1', path: 'src/app/work/page.tsx', line: 23, side: 'RIGHT', from: 'agent', severity: 2, body: 'x' };
  const open = async (n: number, seenBefore: boolean, drafts: Draft[] = []) =>
    openOn({ ...(await new SampleSource().getPr('calebksmith/portfolio', n, null)), seenBefore }, drafts, 'calebksmith');

  it('opens on the most severe item waiting on you, seen before or not', async () => {
    expect(await open(58, false, [agent])).toMatchObject({ step: 'files', item: { id: 'T_58_1', severity: 1 } });
    expect(await open(59, true)).toMatchObject({ step: 'files', item: { id: 'T_59_1' } });
  });

  it('with nothing waiting, opens a first look on Overview and a PR seen before on the files', async () => {
    expect(await open(57, false)).toEqual({ step: 'overview', item: null });
    expect(await open(57, true)).toEqual({ step: 'files', item: null });
  });
});
