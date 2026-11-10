import * as vscode from 'vscode';
import { findingsFor, findingsPath } from './agentReview';
import { excludeLocally } from './gitExclude';
import type { AgentRoute } from './agent';
import { Controller, type Host } from './controller';
import { GitHubSource } from './github';
import { prKey, type CommentAction, type FromWebview, type PrSummary } from './protocol';
import { defaultScope, EVERYTHING_PICK, githubRepos, parseRepositoryInput } from './repos';
import { EVERYTHING, scopeLabel, type Scope } from './scope';
import { SampleSource } from './sample';
import { needsYou, queueGroups, type QueueGroup } from './sidebar';
import { parentOf } from './stacks';
import { bulkMergeable, prStatus, type Tone } from './status';
import type { DataSource } from './source';

const SCOPES = ['repo'];
let panel: vscode.WebviewPanel | undefined;
let controller: Controller | undefined;
/** Where review data comes from right now. The sidebar and the panel share it. */
let source: DataSource | undefined;
let tree: QueueTree;
let treeView: vscode.TreeView<vscode.TreeItem> | undefined;
/** The queue opens by itself once per window, when the sidebar first shows; closing it after that sticks. */
let autoOpened = false;

export function activate(context: vscode.ExtensionContext): void {
  lastContext = context;
  tree = new QueueTree();
  const view = vscode.window.createTreeView('reviewDesk.queue', { treeDataProvider: tree, showCollapseAll: false });
  tree.attach(view);
  treeView = view;
  context.subscriptions.push(
    view,
    command('reviewDesk.open', async () => {
      if (await ensureSource(context)) open(context);
    }),
    command('reviewDesk.connect', async () => {
      if (await ensureSource(context)) await tree.refresh();
    }),
    command('reviewDesk.openPr', async (key: unknown) => {
      if (typeof key === 'string' && (await ensureSource(context))) open(context, key);
    }),
    command('reviewDesk.openOnGitHub', async (item: unknown) => {
      if (item instanceof PrItem) await vscode.env.openExternal(vscode.Uri.parse(item.pr.url));
    }),
    command('reviewDesk.mergeDependabot', async () => {
      if (!(await ensureSource(context))) return;
      open(context);
      await controller?.handle({ type: 'mergeDependabot' });
    }),
    command('reviewDesk.refresh', async () => {
      await tree.refresh();
      await controller?.handle({ type: 'refresh' });
    }),
    vscode.commands.registerCommand('reviewDesk.openSample', () => {
      useSource(new SampleSource());
      open(context);
    }),
    vscode.commands.registerCommand('reviewDesk.openTeamSample', () => {
      useSource(new SampleSource('team'));
      open(context);
    }),
    command('reviewDesk.switchRepository', async () => {
      const scope = await chooseScope(context, true);
      if (scope) { useSource(await githubSource(scope, false)); open(context); }
    }),
    command('reviewDesk.signOut', async () => {
      const scope = await chooseScope(context, false);
      if (scope) { useSource(await githubSource(scope, true)); open(context); }
    }),
    view.onDidChangeVisibility((e) => { if (e.visible) { void tree.refreshIfStale(); autoOpen(context); } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('reviewDesk.label')) void tree.refresh();
      if (!e.affectsConfiguration('reviewDesk.repository') && !e.affectsConfiguration('reviewDesk.repositories')) return;
      // Choose what to review updates these settings itself and has already switched; only follow edits made elsewhere.
      if (source && !source.sample && scopeLabel(currentScope(context)) !== source.scope) void connectQuietly(context);
    }),
  );
  void connectQuietly(context);
}

/** The scope settings and the workspace's last pick point at, without asking. */
function currentScope(context: vscode.ExtensionContext): Scope {
  const settings = vscode.workspace.getConfiguration('reviewDesk');
  return defaultScope(settings.get<string>('repository') ?? '', context.workspaceState.get<string>(REMEMBERED), fullRepos());
}

/** The repos to always show in full, from reviewDesk.repositories, cleaned up and without duplicates. */
function fullRepos(): string[] {
  const listed = vscode.workspace.getConfiguration('reviewDesk').get<string[]>('repositories') ?? [];
  return [...new Set(listed.map((r) => parseRepositoryInput(String(r))).filter((r): r is string => !!r))];
}

/** At startup: connect only if that needs no prompt (already signed in). Otherwise the sidebar offers sign-in. */
async function connectQuietly(context: vscode.ExtensionContext): Promise<void> {
  try {
    const session = await vscode.authentication.getSession('github', SCOPES, { silent: true });
    if (session) useSource(new GitHubSource(session.accessToken, currentScope(context)));
    else tree.show(undefined);
  } catch {
    tree.show(undefined);
  }
}

/** The current source, or a new one after sign-in. False if the reviewer cancels. */
async function ensureSource(context: vscode.ExtensionContext): Promise<boolean> {
  if (source) return true;
  const scope = await chooseScope(context, false);
  if (!scope) return false;
  useSource(await githubSource(scope, false));
  return true;
}

function useSource(next: DataSource): void {
  source = next;
  if (panel) { panel.dispose(); panel = undefined; controller = undefined; }
  tree.show(next);
  if (treeView) autoOpen(treeView.visible ? lastContext : undefined);
}

let lastContext: vscode.ExtensionContext | undefined;

/** Opening the sidebar opens the queue beside it, the first time in a window and once there's something to show. */
function autoOpen(context: vscode.ExtensionContext | undefined): void {
  if (!context || autoOpened || panel || !source || !treeView?.visible) return;
  autoOpened = true;
  open(context);
}

export function deactivate(): void {}

/** Registers a command that shows its errors instead of failing silently. */
function command(id: string, run: (arg?: unknown) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (arg?: unknown) => {
    try {
      await run(arg);
    } catch (err) {
      vscode.window.showErrorMessage(`Review Desk: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function githubSource(scope: Scope, switchAccount: boolean): Promise<DataSource> {
  const session = await vscode.authentication.getSession('github', SCOPES, switchAccount ? { clearSessionPreference: true, createIfNone: true } : { createIfNone: true });
  return new GitHubSource(session.accessToken, scope);
}

/**
 * What to review. Without asking: a pinned repo, the workspace's last pick, or everything that involves you.
 * Asking offers everything, the open folders' repos, or any owner/name. Undefined if the reviewer cancels.
 */
async function chooseScope(context: vscode.ExtensionContext, ask: boolean): Promise<Scope | undefined> {
  if (!ask) return currentScope(context);
  const settings = vscode.workspace.getConfiguration('reviewDesk');
  const now = currentScope(context);
  const picked = await pickScope(await openGitHubRepos(), now);
  if (!picked) return undefined;

  // A repo pinned in settings stays the source of truth: update it where it was set, so the pick sticks.
  const where = settingScope(settings.inspect<string>('repository'));
  if (where !== undefined) await settings.update('repository', picked === EVERYTHING_PICK ? undefined : picked, where);
  await context.workspaceState.update(REMEMBERED, picked);
  return currentScope(context);
}

const REMEMBERED = 'repository';

async function openGitHubRepos(): Promise<string[]> {
  return (await gitRepos()).map((r) => r.name);
}

/** The workspace's git repos that have a GitHub remote, with where each is on disk. */
async function gitRepos(): Promise<{ name: string; root: vscode.Uri }[]> {
  const git = vscode.extensions.getExtension('vscode.git');
  const api = (await git?.activate())?.getAPI(1);
  const repos: { rootUri: vscode.Uri; state: { remotes: { name: string; fetchUrl?: string; pushUrl?: string }[] } }[] = api?.repositories ?? [];
  return repos.flatMap((r) => githubRepos([r]).map((name) => ({ name, root: r.rootUri })));
}

/** Everything that involves you, an open folder's repo, or one typed in. EVERYTHING_PICK means everything. */
async function pickScope(candidates: string[], now: Scope): Promise<string | undefined> {
  const other = 'Another repository…';
  const edit = 'Repositories to always show in full…';
  const full = fullRepos();
  const items: vscode.QuickPickItem[] = [
    { label: `$(globe) ${EVERYTHING}`, description: [now.kind === 'involves' ? 'Reviewing now' : '', full.length ? `+ ${full.join(', ')} in full` : 'across all your repos'].filter(Boolean).join(' · ') },
    { label: 'One repository', kind: vscode.QuickPickItemKind.Separator },
    ...candidates.map((label) => ({ label, description: now.kind === 'repo' && now.repo === label ? 'Reviewing now' : undefined })),
    { label: other, description: 'Type owner/name or paste a GitHub link' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: edit, description: 'Repos whose every PR shows in Everything' },
  ];
  const choice = await vscode.window.showQuickPick(items, { title: 'Review Desk: Choose what to review', placeHolder: 'Everything that involves you, or one repository' });
  if (!choice) return undefined;
  if (choice.label.endsWith(EVERYTHING)) return EVERYTHING_PICK;
  if (choice.label === edit) { await vscode.commands.executeCommand('workbench.action.openSettings', 'reviewDesk.repositories'); return undefined; }
  if (choice.label !== other) return choice.label;
  const typed = await vscode.window.showInputBox({
    title: 'Review Desk: Choose a repository',
    prompt: 'Which repository do you want to review?',
    placeHolder: 'owner/name',
    value: now.kind === 'repo' ? now.repo : '',
    validateInput: (text) => (parseRepositoryInput(text) ? null : 'Type owner/name, like octocat/hello-world, or paste a github.com link'),
  });
  return typed === undefined ? undefined : parseRepositoryInput(typed) ?? undefined;
}

/** Where reviewDesk.repository is set, workspace before user settings; undefined when it isn't set anywhere. */
function settingScope(inspected: { globalValue?: string; workspaceValue?: string } | undefined): vscode.ConfigurationTarget | undefined {
  if (inspected?.workspaceValue?.trim()) return vscode.ConfigurationTarget.Workspace;
  if (inspected?.globalValue?.trim()) return vscode.ConfigurationTarget.Global;
  return undefined;
}

/** Shows the panel, opening a PR if one is given. Reuses the panel that's already open. */
function open(context: vscode.ExtensionContext, key?: string): void {
  if (!source) return;
  if (panel && controller) {
    panel.reveal();
    // A PR to open, or (from Open review queue) back to the queue from whatever PR is showing.
    void controller.handle(key !== undefined ? { type: 'openPr', key } : { type: 'back' });
    return;
  }
  panel = vscode.window.createWebviewPanel('reviewDesk', 'Review Desk', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'review-desk.svg');
  const webview = panel.webview;

  const host: Host = {
    post: (msg) => {
      void webview.postMessage(msg);
      if (msg.type !== 'state') return;
      const st = msg.state;
      // Whatever the panel learns about the queue (after a refresh, approve or merge) updates the sidebar too.
      if (!st.loading && st.view === 'queue') tree.setQueue(st.queue);
      // The tab says what's open, like any editor tab; the sidebar marks the open PR.
      if (panel) panel.title = st.view === 'pr' && st.pr ? `#${st.pr.number} ${st.pr.title}` : 'Review queue';
      if (st.view === 'pr' && st.pr) tree.reveal(prKey(st.pr));
    },
    openFile: async (repo, path, line) => {
      // The PR's repo has to be open here to jump into its files; with several repos in view, find the right folder.
      const root = (await gitRepos()).find((r) => r.name.toLowerCase() === repo.toLowerCase())?.root;
      if (!root) { void vscode.window.showInformationMessage(`Open ${repo} in VS Code to jump to its files.`); return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, path));
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
    },
    openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)); },
    confirm: async (question, action) => (await vscode.window.showWarningMessage(question, { modal: true }, action)) === action,
    askAgent,
    choose: async (title, options) => vscode.window.showQuickPick(options, { title, placeHolder: 'Pick one' }),
    switchRepository: () => { void vscode.commands.executeCommand('reviewDesk.switchRepository'); },
    findingsFile: async (repo, number) => {
      const root = (await gitRepos()).find((r) => r.name.toLowerCase() === repo.toLowerCase())?.root;
      if (!root) return null;
      await excludeReviewDesk(root);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.review-desk'));
      watchFindings(context, root);
      return vscode.Uri.joinPath(root, findingsPath(repo, number)).fsPath;
    },
  };
  const store = { get: <T>(key: string) => context.workspaceState.get<T>(key), set: (key: string, value: unknown) => context.workspaceState.update(key, value) };
  const actions = vscode.workspace.getConfiguration('reviewDesk').get<CommentAction[]>('commentActions') ?? [];
  const c = new Controller(source, store, host, label(), actions.filter((a) => a && typeof a.label === 'string' && typeof a.comment === 'string'), blockerLabels());
  controller = c;
  webview.onDidReceiveMessage((msg: FromWebview) => c.handle(msg), undefined, context.subscriptions);
  panel.onDidDispose(() => { panel = undefined; controller = undefined; }, undefined, context.subscriptions);
  webview.html = html(webview, context.extensionUri);
  // The webview asks for the queue when it's ready; a PR opened now shows once it's loaded.
  if (key !== undefined) void c.handle({ type: 'openPr', key });
}

const label = () => vscode.workspace.getConfiguration('reviewDesk').get<string>('label')?.trim() ?? '';
const blockerLabels = () => (vscode.workspace.getConfiguration('reviewDesk').get<string[]>('blockerLabels') ?? []).filter((l) => typeof l === 'string' && l.trim());

/* ---------- Sidebar ---------- */

const TONE: Record<Tone, { icon: string; color?: string }> = {
  bad: { icon: 'git-pull-request', color: 'testing.iconFailed' },
  warn: { icon: 'git-pull-request', color: 'editorWarning.foreground' },
  run: { icon: 'git-pull-request', color: 'textLink.foreground' },
  ok: { icon: 'git-pull-request', color: 'testing.iconPassed' },
  muted: { icon: 'git-pull-request' },
};

class GroupItem extends vscode.TreeItem {
  constructor(readonly group: QueueGroup) {
    super(group.label, group.bucket === 'merged' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(group.prs.length);
    this.id = `group:${group.bucket}`;
    // "Needs you" offers the one-click Dependabot merge when any update qualifies.
    this.contextValue = group.bucket === 'needs' && bulkMergeable(group.prs).length ? 'group-bulk' : 'group';
  }
}

class PrItem extends vscode.TreeItem {
  constructor(readonly pr: PrSummary, queue: readonly PrSummary[] = []) {
    // The number leads, as in the queue: "#102 Add the login API".
    super(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.None);
    const status = prStatus(pr);
    this.id = `pr:${prKey(pr)}`;
    // Say the status only when it adds to the group's name ("Needs you" already means needs your review).
    const parent = parentOf(pr, queue);
    // With several repos in view, a number alone is ambiguous: say which repo.
    const multi = new Set(queue.map((p) => p.repo)).size > 1;
    this.description = [multi ? pr.repo.split('/')[1] : '', parent ? `on #${parent.number}` : '', status.quiet ? '' : status.label].filter(Boolean).join(' · ');
    this.tooltip = new vscode.MarkdownString(`**${pr.repo}#${pr.number} ${pr.title}**\n\n${status.label} · by ${pr.author} · +${pr.additions} −${pr.deletions}`);
    const t = TONE[status.tone];
    this.iconPath = pr.state === 'merged' ? new vscode.ThemeIcon('git-merge') : new vscode.ThemeIcon(t.icon, t.color ? new vscode.ThemeColor(t.color) : undefined);
    this.contextValue = 'pr';
    this.command = { command: 'reviewDesk.openPr', title: 'Open', arguments: [prKey(pr)] };
  }
}

/** The PR list in the sidebar, with the number that needs the reviewer on the icon. */
class QueueTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<vscode.TreeItem> | undefined;
  private queue: PrSummary[] | null = null;
  private message: string | null = null;
  private loadedAt = 0;

  attach(view: vscode.TreeView<vscode.TreeItem>): void { this.view = view; }

  /** Marks the PR open in the panel, without taking focus from it. */
  reveal(key: string): void {
    const pr = this.queue?.find((p) => prKey(p) === key);
    if (!pr || !this.view?.visible) return;
    void this.view.reveal(new PrItem(pr, this.queue ?? []), { select: true, focus: false, expand: true }).then(undefined, () => {});
  }

  getParent(item: vscode.TreeItem): vscode.TreeItem | undefined {
    if (!(item instanceof PrItem) || !this.queue) return undefined;
    const group = queueGroups(this.queue).find((g) => g.prs.some((p) => prKey(p) === prKey(item.pr)));
    return group ? new GroupItem(group) : undefined;
  }

  /** Switches to a source (or none: then the welcome view offers sign-in) and loads it. */
  show(next: DataSource | undefined): void {
    void vscode.commands.executeCommand('setContext', 'reviewDesk.connected', !!next);
    this.queue = null;
    this.message = null;
    if (this.view) this.view.description = next ? `${next.scope}${next.sample ? ' · sample' : ''}` : undefined;
    this.render();
    if (next) void this.refresh();
  }

  async refresh(): Promise<void> {
    const from = source;
    if (!from) return;
    try {
      const prs = await from.listPrs();
      if (from !== source) return;
      const only = label();
      this.setQueue(only ? prs.filter((p) => p.labels.includes(only)) : prs);
    } catch (err) {
      this.message = `Couldn’t load pull requests: ${err instanceof Error ? err.message : String(err)}`;
      this.render();
    }
  }

  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.loadedAt > 2 * 60_000) await this.refresh();
  }

  setQueue(queue: PrSummary[]): void {
    this.queue = queue;
    this.message = null;
    this.loadedAt = Date.now();
    this.render();
  }

  private render(): void {
    if (this.view) {
      const n = this.queue ? needsYou(this.queue) : 0;
      this.view.badge = n ? { value: n, tooltip: `${n} pull request${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` } : undefined;
      this.view.message = this.message ?? (this.queue && !this.queue.length ? 'No open pull requests.' : undefined);
    }
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (!source) return [];
    if (!this.queue) return item ? [] : [Object.assign(new vscode.TreeItem('Loading pull requests…'), { iconPath: new vscode.ThemeIcon('loading~spin') })];
    if (item instanceof GroupItem) return item.group.prs.map((p) => new PrItem(p, this.queue ?? []));
    return item ? [] : queueGroups(this.queue, blockerLabels()).map((g) => new GroupItem(g));
  }
}

/** Keeps .review-desk/ out of git through the repo's local excludes (never its .gitignore). */
const excludeReviewDesk = (root: vscode.Uri) => excludeLocally(root.fsPath, '.review-desk/', "Review Desk: your agent's review findings");

/** Watches a repo's .review-desk folder; a findings file that appears or changes joins its PR's drafts. */
const watched = new Set<string>();
function watchFindings(context: vscode.ExtensionContext, root: vscode.Uri): void {
  if (watched.has(root.fsPath)) return;
  watched.add(root.fsPath);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.review-desk/*.json'));
  const load = async (uri: vscode.Uri) => {
    const at = findingsFor(uri.fsPath);
    if (!at) return;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))); } catch { return; } // half-written: wait for the next change
    if (!controller) open(context);
    await controller?.importFindings(at, raw);
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(load), watcher.onDidChange(load));
}

/**
 * Gives a prompt to the reviewer's AI agent, filled in but not sent. Claude Code and VS Code's chat
 * are opened through their commands; neither is a documented API, so any failure falls back to the
 * clipboard, which works with every agent.
 */
async function askAgent(prompt: string): Promise<AgentRoute> {
  const choice = vscode.workspace.getConfiguration('reviewDesk').get<string>('agent') ?? 'auto';
  const commands = new Set(await vscode.commands.getCommands(true));
  const tryClaude = (choice === 'auto' || choice === 'claudeCode') && commands.has(CLAUDE_OPEN);
  const tryChat = (choice === 'auto' || choice === 'chat') && commands.has(CHAT_OPEN);
  if (tryClaude) {
    try {
      // Same call Claude Code's own vscode://anthropic.claude-code/open?prompt= link makes: a new session with the prompt in it.
      await vscode.commands.executeCommand(CLAUDE_OPEN, undefined, prompt);
      return 'claudeCode';
    } catch { /* fall through */ }
  }
  if (tryChat) {
    try {
      await vscode.commands.executeCommand(CHAT_OPEN, { query: prompt, isPartialQuery: true, mode: 'agent' });
      return 'chat';
    } catch { /* fall through */ }
  }
  await vscode.env.clipboard.writeText(prompt);
  return 'clipboard';
}

const CLAUDE_OPEN = 'claude-vscode.editor.open';
const CHAT_OPEN = 'workbench.action.chat.open';

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.css'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><title>Review Desk</title></head>
<body><div id="app"></div><div id="toast" class="toast" role="status"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
