import { describe, expect, it } from 'vitest';
import { Controller, type Host } from '../src/controller';
import type { HostState, ToWebview } from '../src/protocol';
import { SampleSource } from '../src/sample';

function setup(label = '', onConfirm: (question: string, action: string) => void = () => {}) {
  const sent: ToWebview[] = [];
  const store = new Map<string, unknown>();
  let confirmed = true;
  const prompts: string[] = [];
  let pick = 0;
  let switched = 0;
  const host: Host = { post: (m) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async (q, a) => { onConfirm(q, a); return confirmed; }, askAgent: async (p) => { prompts.push(p); return 'clipboard'; }, choose: async (_t, options) => options[pick], switchRepository: () => { switched++; }, findingsFile: async () => null };
  const c = new Controller(new SampleSource(), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host, label);
  const last = (): HostState => (sent.filter((m) => m.type === 'state').at(-1) as { state: HostState }).state;
  return { c, sent, store, last, prompts, refuse: () => { confirmed = false; }, choosePick: (i: number) => { pick = i; }, switched: () => switched };
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
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
    expect(store.get('lastSeen:calebksmith/portfolio#52')).toBe('0b8e4f1');
  });

  it('marks a file viewed', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    await c.handle({ type: 'setViewed', path: 'src/lib/track.ts', viewed: true });
    expect(last().pr?.files.find((f) => f.path === 'src/lib/track.ts')?.viewed).toBe('viewed');
  });

  it('approves, then merges only after confirming', async () => {
    const { c, last, refuse, sent } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    await c.handle({ type: 'approve' });
    expect(last().pr?.myReview).toBe('approved');
    refuse();
    await c.handle({ type: 'merge', method: 'squash' });
    expect(last().pr?.state).toBe('open');
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Approved #57')).toBe(true);
  });

  it('merges with the method the reviewer picked, once confirmed', async () => {
    const { c, last, sent } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
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
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    await c.handle({ type: 'approve' });
    refuse();
    await c.handle({ type: 'merge', method: 'squash' });
    expect(asked[0]).toEqual(['Tests is failing on #55. Squash and merge into main anyway?', 'Squash and merge anyway']);
    expect(last().pr?.state).toBe('open');
    expect(sent.some((m) => m.type === 'toast' && m.text.startsWith('Merged'))).toBe(false);
  });

  it('updates a branch that is behind its base, then reloads it', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    expect(last().pr?.mergeState).toBe('behind');
    await c.handle({ type: 'updateBranch' });
    expect(last().pr?.mergeState).toBe('clean');
    expect(last().busy).toBe(null);
  });

  it('shows an error instead of throwing', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#999' });
    expect(last().error).toBe('No sample PR calebksmith/portfolio#999');
  });

  it('marks comments posted since the last look as new', async () => {
    const { c, store, last } = setup();
    store.set('lastSeenAt:calebksmith/portfolio#55', new Date(Date.now() - 30 * 60_000).toISOString());
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    const comments = last().pr!.conversation.flatMap((it) => (it.kind === 'thread' ? it.comments : [it.comment]));
    expect(comments.filter((x) => x.isNew).map((x) => x.author)).toEqual(['claude', 'claude']);
    await c.handle({ type: 'refresh' });
    expect(last().pr!.conversation.some((it) => it.kind === 'comment' && it.comment.isNew)).toBe(false);
  });

  it('keeps “since your last look” and the New tags through background refreshes', async () => {
    const { c, store, last } = setup();
    store.set('lastSeen:calebksmith/portfolio#52', 'old0000');
    store.set('lastSeenAt:calebksmith/portfolio#55', new Date(Date.now() - 30 * 60_000).toISOString());
    const isNew = () => last().pr!.conversation.flatMap((it) => (it.kind === 'thread' ? it.comments : [it.comment])).filter((x) => x.isNew).length;

    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
    expect(last().pr!.sinceLastLook).toMatchObject({ kind: 'look', fromSha: 'old0000' });
    await c.autoRefresh('pr');
    await c.autoRefresh('pr');
    expect(last().pr!.sinceLastLook).toMatchObject({ kind: 'look', fromSha: 'old0000' });

    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    expect(isNew()).toBe(2);
    await c.autoRefresh('pr');
    expect(isNew()).toBe(2);
    // Opening it again is a new look.
    await c.handle({ type: 'refresh' });
    expect(isNew()).toBe(0);
  });

  it('doesn’t mark a PR seen when a background refresh lands after you’ve left it', async () => {
    const { c, store } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
    store.delete('lastSeenAt:calebksmith/portfolio#52');
    const going = c.autoRefresh('pr');
    await c.handle({ type: 'back' });
    await going;
    expect(store.has('lastSeenAt:calebksmith/portfolio#52')).toBe(false);
  });

  it('shows the PR you opened last, even when an earlier one answers later', async () => {
    const { c, store } = setup();
    await c.handle({ type: 'ready' });
    const src = c['source'];
    const real = src.getPr.bind(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    src.getPr = async (repo, n, since) => { if (n === 52) await held; return real(repo, n, since); };
    const slow = c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    release();
    await slow;
    expect(c.snapshot.pr?.number).toBe(55);
    expect(c.snapshot.loading).toBe(false);
    expect(store.get('lastSeen:calebksmith/portfolio#52')).toBeUndefined();
  });

  it('keeps your approval on screen when a background refresh that started before it answers after', async () => {
    const { c } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    const src = c['source'];
    const real = src.getPr.bind(src);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let hold = true;
    src.getPr = async (repo, n, since) => {
      if (!hold) return real(repo, n, since);
      hold = false;
      const old = structuredClone(await real(repo, n, since));
      await held;
      return old;
    };
    const background = c.autoRefresh('pr');
    await c.handle({ type: 'approve' });
    release();
    await background;
    expect(c.snapshot.pr?.myReview).toBe('approved');
  });

  it('marks nothing new the first time a PR is opened', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
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
    source.getPr = async (r, n, s) => ({ ...(await real(r, n, s)), mergeable: false });
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

  it('hands a failing check to the agent and says where the prompt went', async () => {
    const { c, sent, prompts } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#55' });
    await c.handle({ type: 'fixWithAgent', check: 'Tests' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('The "Tests" check is failing');
    expect(prompts[0]).toContain('AssertionError');
    expect(sent.at(-1)).toEqual({ type: 'toast', text: 'Copied why Tests failed as a prompt. Paste it into your agent.' });
  });

  it('posts a comment and shows it in the conversation', async () => {
    const { c, last, sent } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    await c.handle({ type: 'comment', body: '  Looks good, thanks.  ' });
    const latest = last().pr!.conversation.at(-1)!;
    expect(latest).toMatchObject({ kind: 'comment', comment: { author: 'calebksmith', text: 'Looks good, thanks.' } });
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Comment posted')).toBe(true);
    expect(last().busy).toBeNull();
  });

  it('ignores an empty comment', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    const before = last().pr!.conversation.length;
    await c.handle({ type: 'comment', body: '   ' });
    expect(last().pr!.conversation).toHaveLength(before);
  });

  it('sends an unresolved line comment to the agent', async () => {
    const { c, prompts } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#52' });
    await c.handle({ type: 'fixThread', id: 'T_52_1' });
    expect(prompts[0]).toContain('review comment on src/components/WorkCard.tsx:44');
    expect(prompts[0]).toContain('> calebksmith: Should the medal name sit under the summary instead?');
  });

  it('closes a Dependabot PR with the command picked, then leaves it out of the queue', async () => {
    const { c, last, sent, choosePick } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#61' });
    choosePick(0);
    await c.handle({ type: 'closeDependabot' });
    expect(last().view).toBe('queue');
    expect(last().queue.some((p) => p.number === 61)).toBe(false);
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Asked Dependabot to close #61 (“Ignore eslint 10”).')).toBe(true);
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#61' });
    expect(last().pr!.conversation.at(-1)).toMatchObject({ comment: { text: '@dependabot ignore this major version' } });
  });

  it('tells the panel whether the PR was opened before, so it can start on Overview the first time', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    expect(last().pr!.seenBefore).toBe(false);
    await c.handle({ type: 'openPr', key: 'calebksmith/portfolio#57' });
    expect(last().pr!.seenBefore).toBe(true);
  });

  it('passes the repo switcher on to VS Code', async () => {
    const { c, switched } = setup();
    await c.handle({ type: 'switchRepository' });
    expect(switched()).toBe(1);
  });

  it('loads the queue first when the bulk merge starts from the sidebar', async () => {
    const { c, last } = setup();
    await c.handle({ type: 'mergeDependabot' });
    expect(last().queue.find((p) => p.number === 60)?.state).toBe('merged');
  });

  it('on a team, approving says when another approval is still needed', async () => {
    const sent: { type: string; text?: string }[] = [];
    const store = new Map<string, unknown>();
    const host = { post: (m: never) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'clipboard' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
    const c = new Controller(new SampleSource('team'), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
    await c.handle({ type: 'openPr', key: 'acme/storefront#102' });
    await c.handle({ type: 'approve' });
    expect(sent.some((m) => m.type === 'toast' && m.text === 'Approved #102')).toBe(true);
    expect((c.snapshot.pr as { reviewDecision: string }).reviewDecision).toBe('approved');
  });

  it('tells PRs with the same number in different repos apart', async () => {
    const store = new Map<string, unknown>();
    const host = { post: () => {}, openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'clipboard' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
    const c = new Controller(new SampleSource('team'), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
    await c.handle({ type: 'openPr', key: 'acme/storefront#102' });
    expect(c.snapshot.pr?.title).toBe('Add the login API');
    await c.handle({ type: 'openPr', key: 'acme/payments-api#102' });
    expect(c.snapshot.pr?.title).toBe('Rotate API signing keys');
    expect([...store.keys()].filter((k) => k.startsWith('lastSeenAt:')).sort()).toEqual(['lastSeenAt:acme/payments-api#102', 'lastSeenAt:acme/storefront#102']);
  });

  describe('reviews', () => {
    const team = () => {
      const sent: { type: string; text?: string }[] = [];
      const store = new Map<string, unknown>();
      const host = { post: (m: never) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'clipboard' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
      const c = new Controller(new SampleSource('team'), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
      return { c, sent, store, toast: () => sent.filter((m) => m.type === 'toast').at(-1)?.text };
    };

    it('won’t request changes without a summary', async () => {
      const { c, toast } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      await c.handle({ type: 'submitReview', event: 'REQUEST_CHANGES', body: ' ' });
      expect(toast()).toBe('Say what needs to change in the summary first.');
      expect(c.snapshot.pr?.myReview).toBeNull();
    });

    it('sends your comments with the verdict and keeps your agent’s unkept suggestions', async () => {
      const { c, toast } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 1, side: 'RIGHT', body: 'Pin to 22.11' } });
      c['state'].drafts.push({ id: 'agent1', path: '.nvmrc', line: 1, side: 'RIGHT', body: 'P2 maybe', from: 'agent' });
      await c.handle({ type: 'submitReview', event: 'REQUEST_CHANGES', body: 'This conflicts with main. Please merge main and resolve it.' });
      expect(toast()).toBe('Requested changes on #121 with 1 comment.');
      expect(c.snapshot.pr?.myReview).toBe('changes_requested');
      expect(c.snapshot.pr?.conversation.some((it) => it.kind === 'thread' && it.comments[0]?.text === 'Pin to 22.11')).toBe(true);
      expect(c.snapshot.drafts.map((d) => d.id)).toEqual(['agent1']);
    });

    it('puts a comment on a line the diff doesn’t have in the summary, since GitHub refuses it as a line comment', async () => {
      const { c } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      const got: { body: string; drafts: number }[] = [];
      c['source'].submitReview = async (_pr, _event, body, drafts) => { got.push({ body, drafts: drafts.length }); return { unresolved: 0 }; };
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 1, side: 'RIGHT', body: 'Pin to 22.11' } });
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 400, side: 'RIGHT', body: 'Far away' } });
      await c.handle({ type: 'submitReview', event: 'COMMENT', body: 'Two things.' });
      expect(got).toEqual([{ body: 'Two things.\n\n- `.nvmrc:400`: Far away', drafts: 1 }]);
    });

    it('when sending fails, hands the summary back and drops only the comments already in your review on GitHub', async () => {
      const { c, sent } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 1, side: 'RIGHT', body: 'One' } });
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 1, side: 'RIGHT', body: 'Two' } });
      const [one] = c.snapshot.drafts;
      c['source'].submitReview = async () => { throw Object.assign(new Error('GitHub said no'), { added: [one!.id] }); };
      const msg = { type: 'submitReview', event: 'COMMENT', body: 'My summary' } as const;
      await c.handle(msg);
      expect(c.snapshot.error).toBe('GitHub said no');
      expect(c.snapshot.drafts.map((d) => d.body)).toEqual(['Two']);
      expect(sent.at(-1)).toEqual({ type: 'unsent', msg });
    });

    it('compares a re-review with the commit you reviewed', async () => {
      const { c } = team();
      await c.handle({ type: 'ready' });
      await c.handle({ type: 'openPr', key: 'acme/storefront#110' });
      expect(c.snapshot.pr?.sinceLastLook).toMatchObject({ kind: 'review', fromSha: '7a1c0de' });
    });

    it('keeps drafts per PR', async () => {
      const { c } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      await c.handle({ type: 'addDraft', draft: { path: '.nvmrc', line: 1, side: 'RIGHT', body: 'one' } });
      await c.handle({ type: 'openPr', key: 'acme/storefront#126' });
      expect(c.snapshot.drafts).toEqual([]);
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      expect(c.snapshot.drafts.map((d) => d.body)).toEqual(['one']);
    });
  });

  it('loads an agent’s findings as drafts, once, and says how many', async () => {
    const sent: { type: string; text?: string }[] = [];
    const store = new Map<string, unknown>();
    const host = { post: (m: never) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'clipboard' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
    const c = new Controller(new SampleSource('team'), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
    await c.handle({ type: 'openPr', key: 'acme/storefront#102' });
    const findings = [{ path: 'src/server/routes/login.ts', line: 3, severity: 0, title: 'Session fixation', body: 'Rotate the id.' }];
    await c.importFindings({ repo: 'acme/storefront', number: 102 }, findings);
    expect(c.snapshot.drafts).toMatchObject([{ from: 'agent', severity: 0, line: 3 }]);
    expect(sent.at(-1)).toMatchObject({ text: 'Your agent found 1 issue in #102. They’re drafts in Files changed until you keep them.' });
    await c.importFindings({ repo: 'acme/storefront', number: 102 }, findings);
    expect(c.snapshot.drafts).toHaveLength(1);
    // Findings for a PR that isn't open wait in its drafts.
    await c.importFindings({ repo: 'acme/storefront', number: 121 }, [{ path: '.nvmrc', line: 1, severity: 2, body: 'Pin the minor version.' }]);
    expect((store.get('drafts:acme/storefront#121') as unknown[]).length).toBe(1);
  });

  it('says where an agent review’s findings will go', async () => {
    const sent: { type: string; text?: string }[] = [];
    const host = { post: (m: never) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'claudeCode' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
    const store = new Map<string, unknown>();
    const c = new Controller(new SampleSource('team'), { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
    await c.handle({ type: 'openPr', key: 'acme/storefront#102' });
    await c.handle({ type: 'reviewWithAgent' });
    expect(sent.at(-1)).toMatchObject({ text: 'Opened Claude Code with an adversarial review of #102. Open acme/storefront in VS Code to have its findings show up here; until then it replies with them.' });
  });

  describe('refreshing on its own', () => {
    const team = () => {
      const sent: { type: string; text?: string; state?: { loading: boolean } }[] = [];
      const store = new Map<string, unknown>();
      const host = { post: (m: never) => sent.push(m), openFile: () => {}, openExternal: () => {}, confirm: async () => true, askAgent: async () => 'clipboard' as const, choose: async () => undefined, switchRepository: () => {}, findingsFile: async () => null };
      const source = new SampleSource('team');
      const c = new Controller(source, { get: <T>(k: string) => store.get(k) as T, set: (k, v) => { store.set(k, v); } }, host);
      return { c, sent, source };
    };

    it('tells you what arrived on the open PR, without a loading state', async () => {
      const { c, sent, source } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      // Codex reviews while you're away.
      (source as unknown as { find: (r: string, n: number) => { conversation: unknown[] } }).find('acme/storefront', 121).conversation.push(
        { kind: 'thread', id: 'T_new', path: '.nvmrc', line: 1, resolved: false, outdated: false, severity: 1, comments: [{ author: 'chatgpt-codex-connector', createdAt: new Date().toISOString(), html: '', text: 'P1 Pin it', url: 'n', isNew: false }] },
      );
      const mark = sent.length;
      await c.autoRefresh('pr');
      expect(sent.slice(mark).some((m) => m.type === 'state' && m.state!.loading)).toBe(false);
      expect(sent.at(-1)).toMatchObject({ type: 'toast', text: 'Codex left 1 finding.' });
      expect(c.snapshot.updatedAt).not.toBeNull();
    });

    it('doesn’t pull you back to a PR you’ve left', async () => {
      const { c } = team();
      await c.handle({ type: 'openPr', key: 'acme/storefront#121' });
      const going = c.autoRefresh('pr');
      await c.handle({ type: 'back' });
      await going;
      expect(c.snapshot.view).toBe('queue');
    });

    it('says when more PRs became your turn', async () => {
      const { c, sent, source } = team();
      await c.handle({ type: 'ready' });
      (source as unknown as { find: (r: string, n: number) => { summary: { myReview: string | null } } }).find('acme/storefront', 120).summary.myReview = null;
      const s = source as unknown as { prs: { reviewers?: { login: string; state: string }[]; summary: { number: number } }[] };
      s.prs.find((p) => p.summary.number === 111)!.reviewers = [{ login: 'calebksmith', state: 'requested' }];
      await c.autoRefresh('queue');
      expect(sent.at(-1)).toMatchObject({ type: 'toast', text: '1 more PR is your turn.' });
    });
  });
});
