import { describe, expect, it } from 'vitest';
import type { PrDetail } from '../src/protocol';
import { budgetLow, due, dueOnReturn, newlyYourTurn, waiting, whatArrived } from '../src/refresh';
import { SampleSource } from '../src/sample';
import { priority } from '../src/status';

const now = Date.parse('2026-11-10T12:00:00Z');
const base = { now, watching: true, queueAt: now, prAt: now, waiting: false, budget: null };

describe('when to refresh', () => {
  it('refreshes the queue every 5 minutes and the open PR every minute, faster while waiting', () => {
    expect(due({ ...base, queueAt: now - 5 * 60_000, prAt: now - 59_000 })).toEqual({ queue: true, pr: false });
    expect(due({ ...base, prAt: now - 60_000 })).toEqual({ queue: false, pr: true });
    expect(due({ ...base, prAt: now - 30_000, waiting: true })).toEqual({ queue: false, pr: true });
    expect(due({ ...base, prAt: null })).toEqual({ queue: false, pr: false });
  });

  it('does nothing while you’re away, or when the hourly allowance is low', () => {
    expect(due({ ...base, watching: false, queueAt: 0, prAt: 0 })).toEqual({ queue: false, pr: false });
    const low = { remaining: 900, limit: 5000, resetAt: new Date(now + 600_000).toISOString() };
    expect(budgetLow(low, now)).toBe(true);
    expect(due({ ...base, queueAt: 0, prAt: 0, budget: low })).toEqual({ queue: false, pr: false });
    // Once the allowance has reset, it's fine again.
    expect(budgetLow({ ...low, resetAt: new Date(now - 1).toISOString() }, now)).toBe(false);
  });

  it('catches up on return with anything older than a minute', () => {
    expect(dueOnReturn({ now, queueAt: now - 61_000, prAt: now - 10_000, budget: null })).toEqual({ queue: true, pr: false });
  });
});

describe('what you’re waiting on', () => {
  it('waits on running checks, and on a reviewer you asked who hasn’t replied', async () => {
    const s = new SampleSource('team');
    expect(waiting(await s.getPr('acme/storefront', 103, null), [], 'calebksmith')).toBe(true);
    const pr = await s.getPr('acme/storefront', 121, null);
    const codex = [{ label: 'Ask Codex', comment: '@codex review', reviewer: 'chatgpt-codex-connector' }];
    expect(waiting(pr, codex, 'calebksmith')).toBe(false);
    const asked = { ...pr, conversation: [...pr.conversation, { kind: 'comment' as const, comment: { author: 'calebksmith', createdAt: new Date(now).toISOString(), html: '', text: '@codex review', url: 'u', isNew: false } }] };
    expect(waiting(asked, codex, 'calebksmith')).toBe(true);
    const replied = { ...asked, conversation: [...asked.conversation, { kind: 'comment' as const, comment: { author: 'chatgpt-codex-connector[bot]', createdAt: new Date(now + 60_000).toISOString(), html: '', text: 'Reviewed.', url: 'v', isNew: false } }] };
    expect(waiting(replied, codex, 'calebksmith')).toBe(false);
  });
});

describe('what arrived', () => {
  it('names findings by who left them, other comments, pushes and finished checks', async () => {
    const s = new SampleSource('team');
    const after = await s.getPr('acme/storefront', 102, null);
    const before: PrDetail = { ...after, headSha: 'older', conversation: after.conversation.filter((it) => it.kind !== 'thread'), checks: { ...after.checks, pending: 1 } };
    expect(whatArrived(before, after, 'calebksmith')).toBe('Codex left 2 findings, marco pushed new commits, checks passed.');
    expect(whatArrived(after, after, 'calebksmith')).toBeNull();
  });

  it('counts PRs that newly became your turn', async () => {
    const q = await new SampleSource('team').listPrs();
    const yours = (p: (typeof q)[number]) => priority(p).section === 'you';
    expect(newlyYourTurn(q.slice(0, 3), q, yours)).toBe(q.filter(yours).length - q.slice(0, 3).filter(yours).length);
  });
});
