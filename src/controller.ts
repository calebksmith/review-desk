import { parseKey, prKey, type CommentAction, type Draft, type FromWebview, type HostState, type MergeMethod, type PrDetail, type PrSummary, type ReviewEvent, type ToWebview } from './protocol';
import { conflictPrompt, fixPrompt, threadPrompt, type AgentRoute } from './agent';
import { parseFindings, reviewPrompt } from './agentReview';
import { closeOptions, type CloseOption } from './dependabot';
import { markNew } from './conversation';
import { inDiff } from './patch';
import { newlyYourTurn, waiting, whatArrived } from './refresh';
import { DEFAULT_BLOCKER_LABELS } from './signals';
import type { DataSource, Store } from './source';
import { bulkMergeable, bulkSkipReason, isReReview, mergeBlocker, mergeWarning, openFindings, plural, priority, stillOpen } from './status';

export interface Host {
  post(msg: ToWebview): void;
  /** Opens a file of the PR's repo in the editor, if that repo is open here. */
  openFile(repo: string, path: string, line: number | null): void;
  openExternal(url: string): void;
  confirm(question: string, action: string): Promise<boolean>;
  /** Hands a prompt to the reviewer's AI agent, filled in but not sent, and says where it went. */
  askAgent(prompt: string): Promise<AgentRoute>;
  /** Asks the reviewer to pick one option, like VS Code's quick pick. Undefined if they cancel. */
  choose<T extends { label: string; detail?: string }>(title: string, options: T[]): Promise<T | undefined>;
  /** Asks which repo to review, the same as the Switch repository command. */
  switchRepository(): void;
  /**
   * Where the agent should write findings for this PR (the repo's local .review-desk folder, kept out of git),
   * or null when the repo isn't open here. Review Desk watches that file and calls importFindings.
   */
  findingsFile(repo: string, number: number): Promise<string | null>;
}

/**
 * Owns the review state and answers the webview. It has no VS Code imports,
 * so the same code runs in the extension, in tests, and in the browser preview.
 */
export class Controller {
  private state: HostState;

  /**
   * What the open PR is compared against, fixed when you open it: the commit you'd seen (or reviewed) and when.
   * Background refreshes reuse it, so "since your last look" and the New tags last until you open the PR again.
   */
  private opened: { key: string; sinceSha: string | null; kind: 'review' | 'look'; seenAt: string | null } | null = null;

  /**
   * Counts PR loads, and the moves that outdate one still in flight: another load, leaving the PR, an approval's
   * fresher data. A load that finds the count has moved on is dropped.
   */
  private loads = 0;

  /** PRs closed from here this session (by key); GitHub can list them as open for a few seconds after. */
  private readonly closed = new Set<string>();

  constructor(private readonly source: DataSource, private readonly store: Store, private readonly host: Host, private readonly label = '', actions: CommentAction[] = [], blockerLabels: string[] = DEFAULT_BLOCKER_LABELS) {
    this.state = { scope: source.scope, user: '', sample: source.sample, view: 'queue', queue: [], pr: null, loading: true, busy: null, bulk: null, notice: null, actions, blockerLabels, drafts: [], updatedAt: null, error: null };
  }

  get snapshot(): HostState { return this.state; }

  async handle(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': this.push(); await this.loadQueue(); break;
        case 'refresh': this.source.invalidate?.(); await (this.state.view === 'pr' && this.state.pr ? this.loadPr(this.state.pr) : this.loadQueue()); break;
        case 'openPr': { const at = parseKey(msg.key); if (at) await this.loadPr(at); break; }
        case 'back': this.set({ view: 'queue', pr: null }); await this.loadQueue(); break;
        case 'setViewed': await this.setViewed(msg.path, msg.viewed); break;
        case 'approve': await this.approve(); break;
        case 'merge': await this.merge(msg.method); break;
        case 'updateBranch': await this.updateBranch(); break;
        case 'openFile': if (this.state.pr) this.host.openFile(this.state.pr.repo, msg.path, msg.line); break;
        // Web links only: a check's link is set by whatever reported it, and other schemes reach other extensions.
        case 'openExternal': if (/^https?:\/\//i.test(msg.url)) this.host.openExternal(msg.url); break;
        case 'mergeDependabot': await this.mergeDependabot(); break;
        case 'fixWithAgent': await this.fixWithAgent(msg.check); break;
        case 'fixThread': await this.fixThread(msg.id); break;
        case 'fixConflicts': await this.fixConflicts(); break;
        case 'comment': await this.comment(msg.body); break;
        case 'closeDependabot': await this.closeDependabot(); break;
        case 'switchRepository': this.host.switchRepository(); break;
        case 'submitReview': await this.submitReview(msg.event, msg.body); break;
        case 'addDraft': await this.saveDrafts([...this.state.drafts, { ...msg.draft, id: newId(), from: 'you' }]); break;
        case 'editDraft': await this.saveDrafts(this.state.drafts.map((d) => (d.id === msg.id ? { ...d, body: msg.body, from: 'you' } : d))); break;
        case 'keepDraft': await this.saveDrafts(this.state.drafts.map((d) => (d.id === msg.id ? { ...d, from: 'you' } : d))); break;
        case 'deleteDraft': await this.saveDrafts(this.state.drafts.filter((d) => d.id !== msg.id)); break;
        case 'commentNow': await this.commentNow(msg.draft); break;
        case 'reviewWithAgent': await this.reviewWithAgent(); break;
        case 'dismissNotice': this.set({ notice: null }); break;
      }
    } catch (err) {
      this.set({ loading: false, busy: null, error: message(err) });
      // The panel cleared the box when it sent; what was typed goes back so it isn't lost. Only when the send
      // itself failed: after a post that worked (the reload failing, say), handing it back would invite posting twice.
      if ((msg.type === 'comment' || msg.type === 'submitReview' || msg.type === 'commentNow') && err instanceof Object && notPosted.has(err)) this.host.post({ type: 'unsent', msg });
    }
  }

  /** When the queue and the open PR last loaded, for refreshing on a schedule. */
  queueAt = 0;
  prAt = 0;

  private async loadQueue(quiet = false): Promise<void> {
    if (!quiet) this.set({ loading: true, error: null });
    const [user, prs] = await Promise.all([this.source.viewer(), this.source.listPrs()]);
    const queue = (this.label ? prs.filter((p) => p.labels.includes(this.label)) : prs).filter((p) => !this.closed.has(prKey(p)));
    this.queueAt = Date.now();
    this.set({ user, queue, loading: false, ...(this.state.view === 'queue' ? { updatedAt: new Date(this.queueAt).toISOString() } : {}) });
  }

  /**
   * A refresh on a schedule or on coming back: no loading state, nothing reset, and a notice when something
   * arrived (Codex left findings, the author pushed, checks finished, more PRs are your turn).
   */
  async autoRefresh(part: 'queue' | 'pr'): Promise<void> {
    if (this.state.busy) return;
    try {
      if (part === 'pr' && this.state.view === 'pr' && this.state.pr) {
        const before = this.state.pr;
        await this.loadPr(before, true);
        const after = this.state.pr;
        const said = after && prKey(after) === prKey(before) ? whatArrived(before, after, this.state.user) : null;
        if (said) this.host.post({ type: 'toast', text: said });
      } else if (part === 'queue') {
        const before = this.state.queue;
        await this.loadQueue(true);
        const yours = (p: PrSummary) => priority(p).section === 'you';
        const more = before.length ? newlyYourTurn(before, this.state.queue, yours) : 0;
        if (more && this.state.view === 'queue') this.host.post({ type: 'toast', text: `${plural(more, 'more PR')} ${more === 1 ? 'is' : 'are'} your turn.` });
      }
    } catch {
      // A failed background refresh stays quiet; the next one, or Refresh, will try again.
    }
  }

  /** Something on the open PR is expected soon: checks running, or a reviewer you asked who hasn't replied. */
  get waitingOnSomething(): boolean {
    return !!this.state.pr && waiting(this.state.pr, this.state.actions, this.state.user);
  }

  private async loadPr(at: { repo: string; number: number }, quiet = false): Promise<void> {
    if (!quiet) this.set({ view: 'pr', loading: true, error: null, notice: null, pr: this.state.pr && prKey(this.state.pr) === prKey(at) ? this.state.pr : null });
    const load = ++this.loads;
    // Keyed by repo and number, so "new since you looked" survives switching between repos and the combined view.
    const key = `lastSeen:${prKey(at)}`;
    const atKey = `lastSeenAt:${prKey(at)}`;
    // A background refresh of the PR you're on keeps the comparison it was opened with; anything else starts one.
    const kept = quiet && this.opened?.key === prKey(at) ? this.opened : null;
    let since = kept;
    if (!since) {
      // A re-review compares with the commit you reviewed, not the one you last opened.
      const summary = this.state.queue.find((p) => prKey(p) === prKey(at));
      const sinceReview = summary && isReReview(summary) && summary.myReviewSha ? summary.myReviewSha : null;
      since = { key: prKey(at), sinceSha: sinceReview ?? this.store.get<string>(key) ?? null, kind: sinceReview ? 'review' : 'look', seenAt: this.store.get<string>(atKey) ?? null };
    }
    const [pr, me] = await Promise.all([this.source.getPr(at.repo, at.number, since.sinceSha), this.source.viewer()]);
    if (pr.sinceLastLook) pr.sinceLastLook.kind = since.kind;
    // Overtaken while GitHub answered (you opened another PR, left this one, or approved it): this answer is the
    // older one, so it doesn't replace what's on screen, pull you back, or mark anything seen.
    if (load !== this.loads) return;
    // Seen means opened: the next push or comment after this is "new since you looked". Refreshing isn't looking.
    if (!kept) {
      await this.store.set(key, pr.headSha);
      await this.store.set(atKey, new Date().toISOString());
      this.opened = since;
    }
    const seenAt = since.seenAt;
    this.prAt = Date.now();
    this.set({ pr: { ...pr, conversation: markNew(pr.conversation, seenAt, me), seenBefore: seenAt !== null }, drafts: this.store.get<Draft[]>(`drafts:${prKey(at)}`) ?? [], loading: false, updatedAt: new Date(this.prAt).toISOString() });
  }

  private async setViewed(path: string, viewed: boolean): Promise<void> {
    const pr = this.state.pr;
    if (!pr) return;
    const before = pr.files.find((f) => f.path === path)?.viewed;
    // Optimistic: the checkbox flips at once and rolls back if GitHub refuses.
    this.patchFile(path, viewed ? 'viewed' : 'unviewed');
    try {
      await this.source.setViewed(pr, path, viewed);
    } catch (err) {
      if (before) this.patchFile(path, before);
      throw err;
    }
  }

  private async approve(): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    // Codex (or anyone) marked something P0/P1 and nobody has settled it: say so before approving.
    const f = openFindings(pr);
    if ((f.p0 || f.p1) && !(await this.host.confirm(`${stillOpen(f)} on ${this.ref(pr)}. Approve anyway?`, 'Approve anyway'))) return;
    this.set({ busy: 'approve' });
    try {
      await this.source.approve(pr);
      this.source.invalidate?.();
    } finally {
      this.set({ busy: null });
    }
    // Re-read it: on a team, GitHub's review decision may now be approved, or still need someone else.
    const fresh = await this.source.getPr(pr.repo, pr.number, null);
    // Only if you're still on it. This is newer than any load of it still in flight, so that one is dropped.
    if (this.state.pr && prKey(this.state.pr) === prKey(pr)) {
      this.loads++;
      this.set({ loading: false, pr: { ...pr, ...fresh, myReview: 'approved', conversation: pr.conversation, seenBefore: pr.seenBefore, sinceLastLook: pr.sinceLastLook } });
    }
    this.host.post({ type: 'toast', text: fresh.reviewDecision === 'review_required' ? `Approved ${this.ref(pr)}. It needs another approval to merge.` : `Approved ${this.ref(pr)}` });
  }

  private async merge(method: MergeMethod): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    const blocker = mergeBlocker(pr, this.state.queue);
    if (blocker) { this.host.post({ type: 'toast', text: blocker }); return; }
    if (!pr.mergeMethods.includes(method)) method = pr.mergeMethods[0]!;
    const verb = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }[method];
    const warning = mergeWarning(pr);
    const ok = warning
      ? await this.host.confirm(`${warning} on ${this.ref(pr)}. ${verb} into ${pr.baseRef} anyway?`, `${verb} anyway`)
      : await this.host.confirm(`${verb} ${this.ref(pr)} into ${pr.baseRef}?`, verb);
    if (!ok) return;
    this.set({ busy: 'merge' });
    await this.source.merge(pr, method);
    this.source.invalidate?.();
    // A merged PR is a dead end, so go back to the queue for the next one.
    this.set({ busy: null, view: 'queue', pr: null });
    this.host.post({ type: 'toast', text: `Merged ${this.ref(pr)} into ${pr.baseRef}` });
    await this.loadQueue();
  }

  /**
   * Approves and merges every Dependabot PR that has no conflicts and passing checks, one at a time.
   * Each is re-read first: merging one can make the next conflict, since they all touch the lockfile.
   * Anything GitHub refuses (another approval needed, a conflict) is skipped with GitHub's reason.
   */
  private async mergeDependabot(): Promise<void> {
    if (this.state.busy) return;
    // From the sidebar the panel may have just opened, before its queue loaded.
    if (!this.state.queue.length) await this.loadQueue();
    const picks = bulkMergeable(this.state.queue);
    if (!picks.length) return;
    const list = picks.map((p) => `${this.ref(p)} ${p.title}`).join('\n');
    const verb = `Approve and merge ${picks.length}`;
    if (!(await this.host.confirm(`Approve and merge ${plural(picks.length, 'Dependabot update')}, one at a time?\n\n${list}\n\nAny that conflict or fail by their turn are skipped.`, verb))) return;

    const merged: string[] = [];
    const skipped: string[] = [];
    this.set({ busy: 'bulk', bulk: { done: 0, total: picks.length }, notice: null, error: null });
    this.source.invalidate?.();
    for (const [i, p] of picks.entries()) {
      this.set({ bulk: { done: i, total: picks.length } });
      try {
        const pr = await this.source.getPr(p.repo, p.number, null);
        const why = bulkSkipReason(pr);
        if (why) { skipped.push(`${this.ref(p)} (${why})`); continue; }
        if (pr.myReview !== 'approved') await this.source.approve(pr);
        await this.source.merge(pr, pr.mergeMethods[0]!);
        merged.push(this.ref(p));
      } catch (err) {
        skipped.push(`${this.ref(p)} (${message(err).replace(/\.$/, '')})`);
      }
    }
    const done = merged.length ? `Merged ${plural(merged.length, 'Dependabot update')}: ${merged.join(', ')}.` : 'Merged nothing.';
    this.set({ busy: null, bulk: null, notice: skipped.length ? `${done} Skipped ${skipped.join('; ')}.` : done });
    await this.loadQueue();
  }

  /**
   * Sends the review: the verdict, a summary, and the held-back comments you wrote or kept. Your agent's
   * suggestions you haven't kept stay as drafts. Request changes needs a summary, as on GitHub.
   */
  private async submitReview(event: ReviewEvent, body: string): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    const send = this.state.drafts.filter((d) => d.from === 'you');
    if (event === 'REQUEST_CHANGES' && !body.trim()) { this.host.post({ type: 'toast', text: 'Say what needs to change in the summary first.' }); return; }
    if (event === 'COMMENT' && !body.trim() && !send.length) { this.host.post({ type: 'toast', text: 'Write a summary or add a comment first.' }); return; }
    const f = openFindings(pr);
    if (event === 'APPROVE' && (f.p0 || f.p1) && !(await this.host.confirm(`${stillOpen(f)}. Approve anyway?`, 'Approve anyway'))) return;
    this.set({ busy: 'review' });
    let sent = { unresolved: 0 };
    try {
      // GitHub refuses a comment on a line the diff doesn't have (an agent's finding can be anywhere in the file),
      // and one without a line: those go in the summary instead.
      const loose = send.filter((d) => !d.replyTo && !inDiff(pr.files.find((f) => f.path === d.path)?.lines ?? [], d.side, d.line));
      const summary = [body.trim(), ...loose.map((d) => `- \`${d.path}${d.line != null ? `:${d.line}` : ''}\`: ${d.body}`)].filter(Boolean).join('\n\n');
      sent = await this.source.submitReview(pr, event, summary, send.filter((d) => !loose.includes(d)));
      this.source.invalidate?.();
    } catch (err) {
      // Comments that reached your review on GitHub before it failed stay there: sending them again would post them
      // twice. A reply that resolves its thread is kept, marked sent, so the resolve still happens with the review.
      const added = (err as { added?: string[] } | null)?.added ?? [];
      if (added.length) {
        await this.saveDrafts(this.state.drafts.filter((d) => !added.includes(d.id) || d.resolve).map((d) => (added.includes(d.id) ? { ...d, sent: true } : d)));
        this.host.post({ type: 'toast', text: `${plural(added.length, 'comment')} ${added.length === 1 ? 'is' : 'are'} already in your review on GitHub and won’t be sent twice.` });
      }
      throw failedSend(err);
    } finally {
      this.set({ busy: null });
    }
    await this.saveDrafts(this.state.drafts.filter((d) => d.from !== 'you'));
    const posted = send.filter((d) => !d.sent).length;
    const said = { APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on', COMMENT: 'Sent your review of' }[event];
    this.host.post({ type: 'toast', text: `${said} ${this.ref(pr)}${posted ? ` with ${plural(posted, 'comment')}` : ''}.${notResolved(sent)}` });
    await this.loadPr(pr);
  }

  private async commentNow(draft: Omit<Draft, 'id' | 'from'>): Promise<void> {
    const pr = this.state.pr;
    if (!pr || !draft.body.trim() || this.state.busy) return;
    this.set({ busy: 'comment' });
    let sent = { unresolved: 0 };
    try {
      sent = await this.source.commentNow(pr, { ...draft, id: newId(), from: 'you' });
      this.source.invalidate?.();
    } catch (err) {
      throw failedSend(err);
    } finally {
      this.set({ busy: null });
    }
    this.host.post({ type: 'toast', text: `Comment posted${sent.unresolved ? `.${notResolved(sent)}` : ''}` });
    await this.loadPr(pr);
  }

  /**
   * Your own agent reviews the PR adversarially. Its findings come back through a file Review Desk watches
   * (when the repo is open here) and land as drafts marked "from your agent".
   */
  private async reviewWithAgent(): Promise<void> {
    const pr = this.state.pr;
    if (!pr) return;
    const file = await this.host.findingsFile(pr.repo, pr.number);
    const via = await this.host.askAgent(reviewPrompt(pr, file));
    const where = via === 'clipboard' ? 'Copied an adversarial review of' : `Opened ${via === 'claudeCode' ? 'Claude Code' : 'chat'} with an adversarial review of`;
    this.host.post({ type: 'toast', text: file
      ? `${where} ${this.ref(pr)}. Its findings will show up here as drafts.`
      : `${where} ${this.ref(pr)}. Open ${pr.repo} in VS Code to have its findings show up here; until then it replies with them.` });
  }

  /** Findings an agent wrote for a PR: they join that PR's drafts (the open one, or stored for later). */
  async importFindings(at: { repo: string; number: number }, raw: unknown): Promise<void> {
    const key = prKey(at);
    const open = this.state.pr && prKey(this.state.pr) === key ? this.state.pr : null;
    const pr = open ?? (await this.source.getPr(at.repo, at.number, null));
    const found = parseFindings(raw, pr, newId);
    const before = open ? this.state.drafts : this.store.get<Draft[]>(`drafts:${key}`) ?? [];
    // Re-running the review shouldn't duplicate what's already there.
    const fresh = found.filter((f) => !before.some((d) => d.path === f.path && d.line === f.line && d.body === f.body));
    const drafts = [...before, ...fresh];
    await this.store.set(`drafts:${key}`, drafts);
    if (open) this.set({ drafts });
    this.host.post({ type: 'toast', text: fresh.length ? `Your agent found ${plural(fresh.length, 'issue')} in ${this.ref(at)}. They’re drafts in Files changed until you keep them.` : `Your agent found nothing new in ${this.ref(at)}.` });
  }

  /** Held-back comments live per PR in the workspace, so they survive switching PRs and reloads until sent. */
  private async saveDrafts(drafts: Draft[]): Promise<void> {
    const pr = this.state.pr;
    if (!pr) return;
    await this.store.set(`drafts:${prKey(pr)}`, drafts);
    this.set({ drafts });
  }

  private async fixWithAgent(check: string): Promise<void> {
    const pr = this.state.pr;
    const run = pr?.checkRuns.find((r) => r.name === check);
    if (!pr || !run) return;
    const via = await this.host.askAgent(fixPrompt(pr, run));
    const text = {
      claudeCode: `Opened Claude Code with why ${run.name} failed. Read the prompt, then send it.`,
      chat: `Opened chat with why ${run.name} failed. Read the prompt, then send it.`,
      clipboard: `Copied why ${run.name} failed as a prompt. Paste it into your agent.`,
    }[via];
    this.host.post({ type: 'toast', text });
  }

  private async fixThread(id: string): Promise<void> {
    const pr = this.state.pr;
    const thread = pr?.conversation.find((it) => it.kind === 'thread' && it.id === id);
    if (!pr || thread?.kind !== 'thread') return;
    const via = await this.host.askAgent(threadPrompt(pr, thread));
    const where = thread.path.split('/').pop();
    this.host.post({ type: 'toast', text: via === 'clipboard' ? `Copied the comment on ${where} as a prompt. Paste it into your agent.` : `Opened ${via === 'claudeCode' ? 'Claude Code' : 'chat'} with the comment on ${where}. Read the prompt, then send it.` });
  }

  private async fixConflicts(): Promise<void> {
    const pr = this.state.pr;
    if (!pr) return;
    const via = await this.host.askAgent(conflictPrompt(pr));
    this.host.post({ type: 'toast', text: via === 'clipboard' ? 'Copied the conflicts as a prompt. Paste it into your agent.' : `Opened ${via === 'claudeCode' ? 'Claude Code' : 'chat'} to resolve the conflicts. Read the prompt, then send it.` });
  }

  private async comment(body: string): Promise<void> {
    const pr = this.state.pr;
    const text = body.trim();
    if (!pr || !text || this.state.busy) return;
    this.set({ busy: 'comment' });
    try {
      await this.source.comment(pr, text);
      this.source.invalidate?.();
    } catch (err) {
      throw failedSend(err);
    } finally {
      this.set({ busy: null });
    }
    const action = this.state.actions.find((a) => a.comment.trim() === text);
    this.host.post({ type: 'toast', text: action ? `Posted “${text}”. Replies show up in Conversation when you refresh.` : 'Comment posted' });
    await this.loadPr(pr);
  }

  /** Dependabot closes the PR itself when it reads the command, so this posts the command and moves on. */
  private async closeDependabot(): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    const pick: CloseOption | undefined = await this.host.choose(`Close ${this.ref(pr)}: ${pr.title}`, closeOptions(pr));
    if (!pick) return;
    await this.source.comment(pr, pick.comment);
    this.source.invalidate?.();
    this.closed.add(prKey(pr));
    this.set({ view: 'queue', pr: null });
    this.host.post({ type: 'toast', text: `Asked Dependabot to close ${this.ref(pr)} (“${pick.label}”).` });
    await this.loadQueue();
  }

  private async updateBranch(): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    this.set({ busy: 'update' });
    try {
      await this.source.updateBranch(pr);
      this.source.invalidate?.();
    } finally {
      this.set({ busy: null });
    }
    this.host.post({ type: 'toast', text: `Brought ${pr.baseRef} into ${this.ref(pr)}. Checks run again.` });
    await this.loadPr(pr);
  }

  /** "#102", or "storefront#102" when the queue spans repos and a number alone is ambiguous. */
  private ref(pr: Pick<PrSummary, 'repo' | 'number'>): string {
    const repos = new Set(this.state.queue.map((p) => p.repo));
    return repos.size > 1 ? `${pr.repo.split('/')[1]}#${pr.number}` : `#${pr.number}`;
  }

  private patchFile(path: string, viewed: 'viewed' | 'unviewed' | 'changed'): void {
    const pr = this.state.pr;
    if (!pr) return;
    this.set({ pr: { ...pr, files: pr.files.map((f) => (f.path === path ? { ...f, viewed } : f)) } });
  }

  private set(patch: Partial<HostState>): void {
    // Leaving the PR for the queue outdates a load of it still in flight.
    if (patch.view === 'queue') this.loads++;
    this.state = { ...this.state, ...patch };
    this.push();
  }

  private push(): void { this.host.post({ type: 'state', state: this.state }); }
}

/** After a send: the threads GitHub wouldn't resolve, so the reviewer resolves them there instead of sending again. */
const notResolved = (s: { unresolved: number }) => (s.unresolved ? ` ${s.unresolved === 1 ? 'Its thread' : `${s.unresolved} threads`} couldn’t be resolved; resolve ${s.unresolved === 1 ? 'it' : 'them'} on GitHub.` : '');

/** Errors from a send that posted nothing, as far as GitHub said. */
const notPosted = new WeakSet<object>();
const failedSend = (err: unknown) => { if (err instanceof Object) notPosted.add(err); return err; };

function message(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) return 'GitHub sign-in expired. Run “Review Desk: Use a different GitHub account”.';
  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 405) return (err as { message?: string }).message ?? 'GitHub refused the merge.';
  // Octokit appends the docs link to GitHub's message; the message alone reads better.
  return (err instanceof Error ? err.message : String(err)).replace(/ - https:\/\/docs\.github\.com\S*$/, '');
}

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
