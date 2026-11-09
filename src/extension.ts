import * as vscode from 'vscode';
import type { AgentRoute } from './agent';
import { Controller, type Host } from './controller';
import { GitHubSource } from './github';
import type { FromWebview, PrSummary } from './protocol';
import { defaultRepository, githubRepos, parseRepositoryInput } from './repos';
import { SampleSource } from './sample';
import { needsYou, queueGroups, type QueueGroup } from './sidebar';
import { prStatus, type Tone } from './status';
import type { DataSource } from './source';

const SCOPES = ['repo'];
let panel: vscode.WebviewPanel | undefined;
let controller: Controller | undefined;
/** Where review data comes from right now. The sidebar and the panel share it. */
let source: DataSource | undefined;
let tree: QueueTree;

export function activate(context: vscode.ExtensionContext): void {
  tree = new QueueTree();
  const view = vscode.window.createTreeView('reviewDesk.queue', { treeDataProvider: tree, showCollapseAll: false });
  tree.attach(view);
  context.subscriptions.push(
    view,
    command('reviewDesk.open', async () => {
      if (await ensureSource(context)) open(context);
    }),
    command('reviewDesk.connect', async () => {
      if (await ensureSource(context)) await tree.refresh();
    }),
    command('reviewDesk.openPr', async (number: unknown) => {
      if (typeof number === 'number' && (await ensureSource(context))) open(context, number);
    }),
    command('reviewDesk.openOnGitHub', async (item: unknown) => {
      if (item instanceof PrItem) await vscode.env.openExternal(vscode.Uri.parse(item.pr.url));
    }),
    command('reviewDesk.refresh', async () => {
      await tree.refresh();
      await controller?.handle({ type: 'refresh' });
    }),
    vscode.commands.registerCommand('reviewDesk.openSample', () => {
      useSource(new SampleSource());
      open(context);
    }),
    command('reviewDesk.switchRepository', async () => {
      const repo = await repository(context, true);
      if (repo) { useSource(await githubSource(repo, false)); open(context); }
    }),
    command('reviewDesk.signOut', async () => {
      const repo = await repository(context, false);
      if (repo) { useSource(await githubSource(repo, true)); open(context); }
    }),
    view.onDidChangeVisibility((e) => { if (e.visible) void tree.refreshIfStale(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('reviewDesk.label')) void tree.refresh();
      if (!e.affectsConfiguration('reviewDesk.repository')) return;
      // Switch repository updates this setting itself and has already switched; only follow edits made elsewhere.
      const want = vscode.workspace.getConfiguration('reviewDesk').get<string>('repository')?.trim();
      if (want && want !== source?.repo) void connectQuietly(context);
    }),
  );
  void connectQuietly(context);
}

/** At startup: connect only if that needs no prompt (signed in, one obvious repo). Otherwise the sidebar offers sign-in. */
async function connectQuietly(context: vscode.ExtensionContext): Promise<void> {
  try {
    const settings = vscode.workspace.getConfiguration('reviewDesk');
    const repo = defaultRepository(settings.get<string>('repository') ?? '', context.workspaceState.get<string>(REMEMBERED), await openGitHubRepos());
    const session = repo ? await vscode.authentication.getSession('github', SCOPES, { silent: true }) : undefined;
    if (repo && session) useSource(new GitHubSource(session.accessToken, repo));
    else tree.show(undefined);
  } catch {
    tree.show(undefined);
  }
}

/** The current source, or a new one after asking for the repo and sign-in. False if the reviewer cancels. */
async function ensureSource(context: vscode.ExtensionContext): Promise<boolean> {
  if (source) return true;
  const repo = await repository(context, false);
  if (!repo) return false;
  useSource(await githubSource(repo, false));
  return true;
}

function useSource(next: DataSource): void {
  source = next;
  if (panel) { panel.dispose(); panel = undefined; controller = undefined; }
  tree.show(next);
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

async function githubSource(repo: string, switchAccount: boolean): Promise<DataSource> {
  const session = await vscode.authentication.getSession('github', SCOPES, switchAccount ? { clearSessionPreference: true, createIfNone: true } : { createIfNone: true });
  return new GitHubSource(session.accessToken, repo);
}

/**
 * The repo to review. Open uses the setting, the last pick in this workspace, or the only GitHub repo
 * open, and asks only when that leaves a choice. Switch always asks. Undefined if the reviewer cancels.
 */
async function repository(context: vscode.ExtensionContext, ask: boolean): Promise<string | undefined> {
  const settings = vscode.workspace.getConfiguration('reviewDesk');
  const configured = settings.get<string>('repository') ?? '';
  const candidates = await openGitHubRepos();
  if (!ask) {
    const repo = defaultRepository(configured, context.workspaceState.get<string>(REMEMBERED), candidates);
    if (repo) return repo;
  }

  const current = configured.trim() || context.workspaceState.get<string>(REMEMBERED);
  const picked = await pickRepository(candidates, current);
  if (!picked) return undefined;

  // A repo pinned in settings stays the source of truth: update it where it was set, so the pick sticks.
  const scope = settingScope(settings.inspect<string>('repository'));
  if (scope !== undefined) await settings.update('repository', picked, scope);
  else await context.workspaceState.update(REMEMBERED, picked);
  return picked;
}

const REMEMBERED = 'repository';

async function openGitHubRepos(): Promise<string[]> {
  const git = vscode.extensions.getExtension('vscode.git');
  const api = (await git?.activate())?.getAPI(1);
  return githubRepos(api?.repositories ?? []);
}

async function pickRepository(candidates: string[], current: string | undefined): Promise<string | undefined> {
  const other = 'Another repository…';
  if (candidates.length) {
    const items: vscode.QuickPickItem[] = [
      ...candidates.map((label) => ({ label, description: label === current ? 'Reviewing now' : undefined })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: other, description: 'Type owner/name or paste a GitHub link' },
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Review Desk: Choose a repository', placeHolder: 'Which repository do you want to review?' });
    if (!choice) return undefined;
    if (choice.label !== other) return choice.label;
  }
  const typed = await vscode.window.showInputBox({
    title: 'Review Desk: Choose a repository',
    prompt: candidates.length ? 'Which repository do you want to review?' : 'No folder here has a GitHub remote. Which repository do you want to review?',
    placeHolder: 'owner/name',
    value: current,
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
function open(context: vscode.ExtensionContext, number?: number): void {
  if (!source) return;
  if (panel && controller) {
    panel.reveal();
    if (number !== undefined) void controller.handle({ type: 'openPr', number });
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
      // Whatever the panel learns about the queue (after a refresh, approve or merge) updates the sidebar too.
      if (msg.type === 'state' && !msg.state.loading && msg.state.view === 'queue') tree.setQueue(msg.state.queue);
    },
    openFile: async (path, line) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, path));
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
    },
    openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)); },
    confirm: async (question, action) => (await vscode.window.showWarningMessage(question, { modal: true }, action)) === action,
    askAgent,
  };
  const store = { get: <T>(key: string) => context.workspaceState.get<T>(key), set: (key: string, value: unknown) => context.workspaceState.update(key, value) };
  const c = new Controller(source, store, host, label());
  controller = c;
  webview.onDidReceiveMessage((msg: FromWebview) => c.handle(msg), undefined, context.subscriptions);
  panel.onDidDispose(() => { panel = undefined; controller = undefined; }, undefined, context.subscriptions);
  webview.html = html(webview, context.extensionUri);
  // The webview asks for the queue when it's ready; a PR opened now shows once it's loaded.
  if (number !== undefined) void c.handle({ type: 'openPr', number });
}

const label = () => vscode.workspace.getConfiguration('reviewDesk').get<string>('label')?.trim() ?? '';

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
  }
}

class PrItem extends vscode.TreeItem {
  constructor(readonly pr: PrSummary) {
    super(pr.title, vscode.TreeItemCollapsibleState.None);
    const status = prStatus(pr);
    this.id = `pr:${pr.number}`;
    this.description = `#${pr.number} · ${status.label}`;
    this.tooltip = new vscode.MarkdownString(`**#${pr.number} ${pr.title}**\n\n${status.label} · by ${pr.author} · +${pr.additions} −${pr.deletions}`);
    const t = TONE[status.tone];
    this.iconPath = pr.state === 'merged' ? new vscode.ThemeIcon('git-merge') : new vscode.ThemeIcon(t.icon, t.color ? new vscode.ThemeColor(t.color) : undefined);
    this.contextValue = 'pr';
    this.command = { command: 'reviewDesk.openPr', title: 'Open', arguments: [pr.number] };
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

  /** Switches to a source (or none: then the welcome view offers sign-in) and loads it. */
  show(next: DataSource | undefined): void {
    void vscode.commands.executeCommand('setContext', 'reviewDesk.connected', !!next);
    this.queue = null;
    this.message = null;
    if (this.view) this.view.description = next ? `${next.repo}${next.sample ? ' · sample' : ''}` : undefined;
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
    if (item instanceof GroupItem) return item.group.prs.map((p) => new PrItem(p));
    return item ? [] : queueGroups(this.queue).map((g) => new GroupItem(g));
  }
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
