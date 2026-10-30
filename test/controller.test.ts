import { describe, expect, it } from 'vitest';
import { Controller, type Host } from '../src/controller';
import type { HostState, ToWebview } from '../src/protocol';
import { SampleSource } from '../src/sample';

function setup(label = '') {
  const sent: ToWebview[] = [];
  const store = new Map<string, unknown>();
  let confirmed = true;
  const host: Host = { post: (m) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => confirmed };
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
    await c.handle({ type: 'merge' });
    expect(last().pr?.state).toBe('open');
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Approved #57')).toBe(true);
  });

  it('shows an error instead of throwing', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', number: 999 });
    expect(last().error).toBe('No sample PR #999');
  });
});
