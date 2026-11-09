import type { FromWebview, HostState, MergeMethod, ToWebview } from './protocol';
import { fixPrompt, type AgentRoute } from './agent';
import { markNew } from './conversation';
import type { DataSource, Store } from './source';
import { bulkMergeable, bulkSkipReason, mergeBlocker, mergeWarning, plural } from './status';

export interface Host {
  post(msg: ToWebview): void;
  openFile(path: string, line: number | null): void;
  openExternal(url: string): void;
  confirm(question: string, action: string): Promise<boolean>;
  /** Hands a prompt to the reviewer's AI agent, filled in but not sent, and says where it went. */
  askAgent(prompt: string): Promise<AgentRoute>;
}

/**
 * Owns the review state and answers the webview. It has no VS Code imports,
 * so the same code runs in the extension, in tests, and in the browser preview.
 */
export class Controller {
  private state: HostState;

  constructor(private readonly source: DataSource, private readonly store: Store, private readonly host: Host, private readonly label = '') {
    this.state = { repo: source.repo, user: '', sample: source.sample, view: 'queue', queue: [], pr: null, loading: true, busy: null, bulk: null, notice: null, error: null };
  }

  get snapshot(): HostState { return this.state; }

  async handle(msg: FromWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': this.push(); await this.loadQueue(); break;
        case 'refresh': await (this.state.view === 'pr' && this.state.pr ? this.loadPr(this.state.pr.number) : this.loadQueue()); break;
        case 'openPr': await this.loadPr(msg.number); break;
        case 'back': this.set({ view: 'queue', pr: null }); await this.loadQueue(); break;
        case 'setViewed': await this.setViewed(msg.path, msg.viewed); break;
        case 'approve': await this.approve(); break;
        case 'merge': await this.merge(msg.method); break;
        case 'updateBranch': await this.updateBranch(); break;
        case 'openFile': this.host.openFile(msg.path, msg.line); break;
        case 'openExternal': this.host.openExternal(msg.url); break;
        case 'mergeDependabot': await this.mergeDependabot(); break;
        case 'fixWithAgent': await this.fixWithAgent(msg.check); break;
        case 'dismissNotice': this.set({ notice: null }); break;
      }
    } catch (err) {
      this.set({ loading: false, busy: null, error: message(err) });
    }
  }

  private async loadQueue(): Promise<void> {
    this.set({ loading: true, error: null });
    const [user, prs] = await Promise.all([this.source.viewer(), this.source.listPrs()]);
    const queue = this.label ? prs.filter((p) => p.labels.includes(this.label)) : prs;
    this.set({ user, queue, loading: false });
  }

  private async loadPr(number: number): Promise<void> {
    this.set({ view: 'pr', loading: true, error: null, notice: null, pr: this.state.pr?.number === number ? this.state.pr : null });
    const key = `lastSeen:${this.source.repo}#${number}`;
    const atKey = `lastSeenAt:${this.source.repo}#${number}`;
    const seenAt = this.store.get<string>(atKey) ?? null;
    const [pr, me] = await Promise.all([this.source.getPr(number, this.store.get<string>(key) ?? null), this.source.viewer()]);
    // Seen means opened: the next push or comment after this is "new since you looked".
    await this.store.set(key, pr.headSha);
    await this.store.set(atKey, new Date().toISOString());
    this.set({ pr: { ...pr, conversation: markNew(pr.conversation, seenAt, me) }, loading: false });
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
    this.set({ busy: 'approve' });
    await this.source.approve(pr);
    this.set({ busy: null, pr: { ...pr, myReview: 'approved' } });
    this.host.post({ type: 'toast', text: `Approved #${pr.number}` });
  }

  private async merge(method: MergeMethod): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    const blocker = mergeBlocker(pr);
    if (blocker) { this.host.post({ type: 'toast', text: blocker }); return; }
    if (!pr.mergeMethods.includes(method)) method = pr.mergeMethods[0]!;
    const verb = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }[method];
    const warning = mergeWarning(pr);
    const ok = warning
      ? await this.host.confirm(`${warning} on #${pr.number}. ${verb} into ${pr.baseRef} anyway?`, `${verb} anyway`)
      : await this.host.confirm(`${verb} #${pr.number} into ${pr.baseRef}?`, verb);
    if (!ok) return;
    this.set({ busy: 'merge' });
    await this.source.merge(pr, method);
    // A merged PR is a dead end, so go back to the queue for the next one.
    this.set({ busy: null, view: 'queue', pr: null });
    this.host.post({ type: 'toast', text: `Merged #${pr.number} into ${pr.baseRef}` });
    await this.loadQueue();
  }

  /**
   * Approves and merges every Dependabot PR that has no conflicts and passing checks, one at a time.
   * Each is re-read first: merging one can make the next conflict, since they all touch the lockfile.
   * Anything GitHub refuses (another approval needed, a conflict) is skipped with GitHub's reason.
   */
  private async mergeDependabot(): Promise<void> {
    if (this.state.busy) return;
    const picks = bulkMergeable(this.state.queue);
    if (!picks.length) return;
    const list = picks.map((p) => `#${p.number} ${p.title}`).join('\n');
    const verb = `Approve and merge ${picks.length}`;
    if (!(await this.host.confirm(`Approve and merge ${plural(picks.length, 'Dependabot update')}, one at a time?\n\n${list}\n\nAny that conflict or fail by their turn are skipped.`, verb))) return;

    const merged: number[] = [];
    const skipped: string[] = [];
    this.set({ busy: 'bulk', bulk: { done: 0, total: picks.length }, notice: null, error: null });
    for (const [i, p] of picks.entries()) {
      this.set({ bulk: { done: i, total: picks.length } });
      try {
        const pr = await this.source.getPr(p.number, null);
        const why = bulkSkipReason(pr);
        if (why) { skipped.push(`#${p.number} (${why})`); continue; }
        if (pr.myReview !== 'approved') await this.source.approve(pr);
        await this.source.merge(pr, pr.mergeMethods[0]!);
        merged.push(p.number);
      } catch (err) {
        skipped.push(`#${p.number} (${message(err).replace(/\.$/, '')})`);
      }
    }
    const done = merged.length ? `Merged ${plural(merged.length, 'Dependabot update')}: ${merged.map((n) => `#${n}`).join(', ')}.` : 'Merged nothing.';
    this.set({ busy: null, bulk: null, notice: skipped.length ? `${done} Skipped ${skipped.join('; ')}.` : done });
    await this.loadQueue();
  }

  private async fixWithAgent(check: string): Promise<void> {
    const pr = this.state.pr;
    const run = pr?.checkRuns.find((r) => r.name === check);
    if (!pr || !run) return;
    const via = await this.host.askAgent(fixPrompt(this.source.repo, pr, run));
    const text = {
      claudeCode: `Opened Claude Code with why ${run.name} failed. Read the prompt, then send it.`,
      chat: `Opened chat with why ${run.name} failed. Read the prompt, then send it.`,
      clipboard: `Copied why ${run.name} failed as a prompt. Paste it into your agent.`,
    }[via];
    this.host.post({ type: 'toast', text });
  }

  private async updateBranch(): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    this.set({ busy: 'update' });
    try {
      await this.source.updateBranch(pr);
    } finally {
      this.set({ busy: null });
    }
    this.host.post({ type: 'toast', text: `Brought ${pr.baseRef} into #${pr.number}. Checks run again.` });
    await this.loadPr(pr.number);
  }

  private patchFile(path: string, viewed: 'viewed' | 'unviewed' | 'changed'): void {
    const pr = this.state.pr;
    if (!pr) return;
    this.set({ pr: { ...pr, files: pr.files.map((f) => (f.path === path ? { ...f, viewed } : f)) } });
  }

  private set(patch: Partial<HostState>): void {
    this.state = { ...this.state, ...patch };
    this.push();
  }

  private push(): void { this.host.post({ type: 'state', state: this.state }); }
}

function message(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) return 'GitHub sign-in expired. Run “Review Desk: Use a different GitHub account”.';
  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 405) return (err as { message?: string }).message ?? 'GitHub refused the merge.';
  // Octokit appends the docs link to GitHub's message; the message alone reads better.
  return (err instanceof Error ? err.message : String(err)).replace(/ - https:\/\/docs\.github\.com\S*$/, '');
}
