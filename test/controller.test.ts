import { describe, expect, it } from 'vitest';
import { Controller, type Host } from '../src/controller';
import type { HostState, ToWebview } from '../src/protocol';
import { SampleSource } from '../src/sample';

function setup(label = '', onConfirm: (question: string, action: string) => void = () => {}) {
  const sent: ToWebview[] = [];
  const store = new Map<string, unknown>();
  let confirmed = true;
  const host: Host = { post: (m) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async (q, a) => { onConfirm(q, a); return confirmed; } };
  const c = new Controller(new SampleSource(), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host, label);
  const last = (): HostState => (sent.filter((m) => m.type === 'state').at(-1) as { state: HostState }).state;
  return { c, sent, store, last, refuse: () => { confirmed = false; } };
}

describe('Controller', () => {
  it('loads the queue on ready', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'ready' });
    expect(last().loading).toBe(false);
    expect(last().queue.map((p) => p.number)).toContain(55);
    expect(last().user).toBe('calebksmith');
  });

  it('filters the queue by label', async () => {
    const { c, last } = setup('review-desk');
    await c.handle({ type: 'ready' });
    expect(last().queue.every((p) => p.labels.includes('review-desk'))).toBe(true);
    expect(last().queue.some((p) => p.number === 48)).toBe(false);
  });

  it('remembers the head the reviewer saw', async () => {
    const { c, store } = setup();
    await c.handle({ type: 'openPr', number: 52 });
    expect(store.get('lastSeen:calebksmith/portfolio#52')).toBe('0b8e4f1');
  });

  it('marks a file viewed', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', number: 55 });
    await c.handle({ type: 'setViewed', path: 'src/lib/track.ts', viewed: true });
    expect(last().pr?.files.find((f) => f.path === 'src/lib/track.ts')?.viewed).toBe('viewed');
  });

  it('approves, then merges only after confirming', async () => {
    const { c, last, refuse, sent } = setup();
    await c.handle({ type: 'openPr', number: 57 });
    await c.handle({ type: 'approve' });
    expect(last().pr?.myReview).toBe('approved');
    refuse();
    await c.handle({ type: 'merge', method: 'squash' });
    expect(last().pr?.state).toBe('open');
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Approved #57')).toBe(true);
  });

  it('merges with the method the reviewer picked, once confirmed', async () => {
    const { c, last, sent } = setup();
    await c.handle({ type: 'openPr', number: 52 });
    await c.handle({ type: 'approve' });
    await c.handle({ type: 'merge', method: 'rebase' });
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Merged #52 into main')).toBe(true);
    // Nothing is left to do on a merged PR, so the reviewer lands back on the queue, now showing it merged.
    expect(last().view).toBe('queue');
    expect(last().pr).toBeNull();
    expect(last().queue.find((p) => p.number === 52)?.state).toBe('merged');
  });

  it('merges with a failing check only after a warning that names it', async () => {
    const asked: [string, string][] = [];
    const { c, last, sent, refuse } = setup(undefined, (q, a) => asked.push([q, a]));
    await c.handle({ type: 'openPr', number: 55 });
    await c.handle({ type: 'approve' });
    refuse();
    await c.handle({ type: 'merge', method: 'squash' });
    expect(asked[0]).toEqual(['Tests is failing on #55. Squash and merge into main anyway?', 'Squash and merge anyway']);
    expect(last().pr?.state).toBe('open');
    expect(sent.some((m) => m.type === 'toast' && m.text.startsWith('Merged'))).toBe(false);
  });

  it('updates a branch that is behind its base, then reloads it', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', number: 57 });
    expect(last().pr?.mergeState).toBe('behind');
    await c.handle({ type: 'updateBranch' });
    expect(last().pr?.mergeState).toBe('clean');
    expect(last().busy).toBe(null);
  });

  it('shows an error instead of throwing', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', number: 999 });
    expect(last().error).toBe('No sample PR #999');
  });

  it('marks comments posted since the last look as new', async () => {
    const { c, store, last } = setup();
    store.set('lastSeenAt:calebksmith/portfolio#55', new Date(Date.now() - 30 * 60_000).toISOString());
    await c.handle({ type: 'openPr', number: 55 });
    const comments = last().pr!.conversation.flatMap((it) => (it.kind === 'thread' ? it.comments : [it.comment]));
    expect(comments.filter((x) => x.isNew).map((x) => x.author)).toEqual(['claude', 'claude']);
    await c.handle({ type: 'refresh' });
    expect(last().pr!.conversation.some((it) => it.kind === 'comment' && it.comment.isNew)).toBe(false);
  });

  it('marks nothing new the first time a PR is opened', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', number: 55 });
    expect(JSON.stringify(last().pr!.conversation)).not.toContain('"isNew":true');
  });

  it('approves and merges passing Dependabot updates in one go, skipping the rest', async () => {
    const asked: string[] = [];
    const { c, last } = setup(undefined, (q) => asked.push(q));
    await c.handle({ type: 'ready' });
    await c.handle({ type: 'mergeDependabot' });
    expect(asked[0]).toContain('#60 Bump vite');
    expect(asked[0]).not.toContain('#61');
    const merged = last().queue.find((p) => p.number === 60)!;
    expect(merged.state).toBe('merged');
    expect(merged.myReview).toBe('approved');
    expect(last().queue.find((p) => p.number === 61)?.state).toBe('open');
    expect(last().notice).toBe('Merged 1 Dependabot update: #60.');
    expect(last().busy).toBeNull();
    await c.handle({ type: 'dismissNotice' });
    expect(last().notice).toBeNull();
  });

  it('skips a PR that changed by its turn, with the reason', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'ready' });
    const source = (c as unknown as { source: SampleSource }).source;
    const real = source.getPr.bind(source);
    source.getPr = async (n, s) => ({ ...(await real(n, s)), mergeable: false });
    await c.handle({ type: 'mergeDependabot' });
    expect(last().notice).toBe('Merged nothing. Skipped #60 (conflicts with its base).');
  });

  it('does nothing when the reviewer cancels', async () => {
    const { c, last, refuse } = setup();
    await c.handle({ type: 'ready' });
    refuse();
    await c.handle({ type: 'mergeDependabot' });
    expect(last().queue.find((p) => p.number === 60)?.state).toBe('open');
    expect(last().notice).toBeNull();
  });
});
