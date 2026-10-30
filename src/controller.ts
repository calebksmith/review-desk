import type { FromWebview, HostState, ToWebview } from './protocol';
import type { DataSource, Store } from './source';

export interface Host {
  post(msg: ToWebview): void;
  openFile(path: string, line: number | null): void;
  openExternal(url: string): void;
  confirm(question: string, action: string): Promise<boolean>;
}

/**
 * Owns the review state and answers the webview. It has no VS Code imports,
 * so the same code runs in the extension, in tests, and in the browser preview.
 */
export class Controller {
  private state: HostState;

  constructor(private readonly source: DataSource, private readonly store: Store, private readonly host: Host, private readonly label = '') {
    this.state = { repo: source.repo, user: '', sample: source.sample, view: 'queue', queue: [], pr: null, loading: true, busy: null, error: null };
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
        case 'merge': await this.merge(); break;
        case 'openFile': this.host.openFile(msg.path, msg.line); break;
        case 'openExternal': this.host.openExternal(msg.url); break;
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
    this.set({ view: 'pr', loading: true, error: null, pr: this.state.pr?.number === number ? this.state.pr : null });
    const key = `lastSeen:${this.source.repo}#${number}`;
    const pr = await this.source.getPr(number, this.store.get<string>(key) ?? null);
    // Seen means opened: the next push after this one is "new since you looked".
    await this.store.set(key, pr.headSha);
    this.set({ pr, loading: false });
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

  private async merge(): Promise<void> {
    const pr = this.state.pr;
    if (!pr || this.state.busy) return;
    if (!(await this.host.confirm(`Merge #${pr.number} into ${pr.baseRef}?`, 'Merge'))) return;
    this.set({ busy: 'merge' });
    await this.source.merge(pr);
    this.set({ busy: null, pr: { ...pr, state: 'merged' } });
    this.host.post({ type: 'toast', text: `Merged #${pr.number} into ${pr.baseRef}` });
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
  return err instanceof Error ? err.message : String(err);
}
