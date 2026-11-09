import * as vscode from 'vscode';
import type { AgentRoute } from './agent';
import { Controller, type Host } from './controller';
import { GitHubSource } from './github';
import type { FromWebview } from './protocol';
import { defaultRepository, githubRepos, parseRepositoryInput } from './repos';
import { SampleSource } from './sample';
import type { DataSource } from './source';

const SCOPES = ['repo'];
let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    command('reviewDesk.open', async () => {
      const repo = await repository(context, false);
      if (repo) open(context, await githubSource(repo, false));
    }),
    vscode.commands.registerCommand('reviewDesk.openSample', () => open(context, new SampleSource())),
    command('reviewDesk.switchRepository', async () => {
      const repo = await repository(context, true);
      if (repo) open(context, await githubSource(repo, false));
    }),
    command('reviewDesk.signOut', async () => {
      const repo = await repository(context, false);
      if (repo) open(context, await githubSource(repo, true));
    }),
  );
}

export function deactivate(): void {}

/** Registers a command that shows its errors instead of failing silently. */
function command(id: string, run: () => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async () => {
    try {
      await run();
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


function open(context: vscode.ExtensionContext, source: DataSource): void {
  panel?.dispose();
  panel = vscode.window.createWebviewPanel('reviewDesk', 'Review Desk', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
  });
  const webview = panel.webview;

  const host: Host = {
    post: (msg) => { void webview.postMessage(msg); },
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
  const label = vscode.workspace.getConfiguration('reviewDesk').get<string>('label')?.trim() ?? '';
  const store = { get: <T>(key: string) => context.workspaceState.get<T>(key), set: (key: string, value: unknown) => context.workspaceState.update(key, value) };
  const controller = new Controller(source, store, host, label);
  webview.onDidReceiveMessage((msg: FromWebview) => controller.handle(msg), undefined, context.subscriptions);
  panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
  webview.html = html(webview, context.extensionUri);
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
