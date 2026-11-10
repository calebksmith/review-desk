import { describe, expect, it } from 'vitest';
import { SampleSource } from '../src/sample';

describe('team sample', () => {
  it('won’t let you approve your own PR', async () => {
    const s = new SampleSource('team');
    await expect(s.approve(await s.getPr(122, null))).rejects.toThrow(/own pull request/);
  });

  it('won’t merge without the required approval', async () => {
    const s = new SampleSource('team');
    await expect(s.merge(await s.getPr(125, null), 'squash')).rejects.toThrow(/approving review is required/);
    await s.approve(await s.getPr(125, null));
    await s.merge(await s.getPr(125, null), 'squash');
    expect((await s.getPr(125, null)).state).toBe('merged');
  });

  it('moves the next PR in a stack onto main when the bottom one merges', async () => {
    const s = new SampleSource('team');
    expect((await s.getPr(102, null)).baseRef).toBe('marco/session-store');
    await s.merge(await s.getPr(101, null), 'squash');
    expect((await s.getPr(102, null)).baseRef).toBe('main');
    expect((await s.getPr(103, null)).baseRef).toBe('marco/login-api');
  });
});
