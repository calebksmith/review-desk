import { describe, expect, it } from 'vitest';
import { conversationCounts, markNew, severityOf, toConversation, type RawComment, type RawReview } from '../src/conversation';

const c = (login: string, at: string, html = '<p>hi</p>'): RawComment => ({ author: { login }, createdAt: at, body: html.replace(/<[^>]+>/g, ''), bodyHTML: html, url: 'u' });
const r = (state: RawReview['state'], at: string | null, body = ''): RawReview => ({ author: { login: 'rev' }, state, submittedAt: at, body, bodyHTML: body && `<p>${body}</p>`, url: 'u' });

describe('toConversation', () => {
  it('merges comments, reviews and threads oldest first', () => {
    const items = toConversation(
      [c('agent', '2026-01-01T03:00:00Z')],
      [r('CHANGES_REQUESTED', '2026-01-01T01:00:00Z', 'Fix it')],
      [{ id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 4, originalLine: 3, comments: { nodes: [c('rev', '2026-01-01T02:00:00Z')] } }],
    );
    expect(items.map((i) => i.kind)).toEqual(['review', 'thread', 'comment']);
    expect(items[0]).toMatchObject({ verdict: 'changes_requested', comment: { author: 'rev', html: '<p>Fix it</p>' } });
    expect(items[1]).toMatchObject({ path: 'a.ts', line: 4, resolved: false });
  });

  it('leaves out drafts and empty "commented" reviews, which only wrap line comments', () => {
    const items = toConversation([], [r('PENDING', null, 'draft'), r('COMMENTED', '2026-01-01T01:00:00Z'), r('APPROVED', '2026-01-01T02:00:00Z')], []);
    expect(items).toEqual([expect.objectContaining({ kind: 'review', verdict: 'approved' })]);
  });

  it('uses the original line when the thread is outdated', () => {
    const [t] = toConversation([], [], [{ id: 't1', isResolved: true, isOutdated: true, path: 'a.ts', line: null, originalLine: 9, comments: { nodes: [c('rev', '2026-01-01T01:00:00Z')] } }]);
    expect(t).toMatchObject({ line: 9, outdated: true });
  });

  it('names deleted accounts "ghost"', () => {
    const [i] = toConversation([{ ...c('x', '2026-01-01T01:00:00Z'), author: null }], [], []);
    expect(i).toMatchObject({ comment: { author: 'ghost' } });
  });
});

describe('markNew', () => {
  const items = toConversation(
    [c('agent', '2026-01-01T01:00:00Z'), c('agent', '2026-01-01T03:00:00Z'), c('me', '2026-01-01T04:00:00Z')],
    [],
    [{ id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, originalLine: 1, comments: { nodes: [c('me', '2026-01-01T00:30:00Z'), c('agent', '2026-01-01T05:00:00Z')] } }],
  );

  it('flags what others posted after the last look', () => {
    const counts = conversationCounts(markNew(items, '2026-01-01T02:00:00.000Z', 'me'));
    expect(counts).toEqual({ comments: 5, fresh: 2, unresolved: 1 });
  });

  it('flags nothing on a first look', () => {
    expect(conversationCounts(markNew(items, null, 'me')).fresh).toBe(0);
  });
});

describe('severityOf', () => {
  it.each([
    ['**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Guard against a null user', 1],
    ['P0: tokens are logged in plain text', 0],
    ['Consider renaming this (P2)', 2],
    ['Use HTTP2 here', null],
    ['No priority', null],
  ])('%s', (text, sev) => expect(severityOf(text as string)).toBe(sev));
});
