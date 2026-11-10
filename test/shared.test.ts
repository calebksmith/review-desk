import { describe, expect, it } from 'vitest';
import { SampleSource } from '../src/sample';
import { SharedSource } from '../src/shared';

describe('shared queue', () => {
  it('loads once for the sidebar and the panel, until it’s stale or invalidated', async () => {
    const inner = new SampleSource('team');
    let calls = 0;
    const listPrs = inner.listPrs.bind(inner);
    inner.listPrs = () => { calls++; return listPrs(); };
    let t = 0;
    const shared = new SharedSource(inner, 30_000, () => t);
    await Promise.all([shared.listPrs(), shared.listPrs()]);
    t = 29_000; await shared.listPrs();
    expect(calls).toBe(1);
    t = 30_000; await shared.listPrs();
    expect(calls).toBe(2);
    shared.invalidate(); await shared.listPrs();
    expect(calls).toBe(3);
    expect(shared.scope).toBe('Everything involving you');
  });

  it('doesn’t keep a failed load', async () => {
    const inner = new SampleSource();
    let fail = true;
    const listPrs = inner.listPrs.bind(inner);
    inner.listPrs = () => (fail ? Promise.reject(new Error('offline')) : listPrs());
    const shared = new SharedSource(inner);
    await expect(shared.listPrs()).rejects.toThrow('offline');
    fail = false;
    expect((await shared.listPrs()).length).toBeGreaterThan(0);
  });
});
