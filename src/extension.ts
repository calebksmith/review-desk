import * as vscode from 'vscode';
import { Controller, type Host } from './controller';
import { GitHubSource } from './github';
import type { FromWebview } from './protocol';
import { parseRemote } from './remote';
import { SampleSource } from './sample';
import type { DataSource } from './source';

const SCOPES = ['repo'];
let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('reviewDesk.open', async () => {
      try {
        open(context, await githubSource(false));
      } catch (err) {
        vscode.window.showErrorMessage(`Review Desk: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('reviewDesk.openSample', () => open(context, new SampleSource())),
    vscode.commands.registerCommand('reviewDesk.signOut', async () => {
      try {
        open(context, await githubSource(true));
      } catch (err) {
        vscode.window.showErrorMessage(`Review Desk: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export function deactivate(): void {}

async function githubSource(switchAccount: boolean): Promise<DataSource> {
  const session = await vscode.authentication.getSession('github', SCOPES, switchAccount ? { clearSessionPreference: true, createIfNone: true } : { createIfNone: true });
  return new GitHubSource(session.accessToken, await repository());
}

/** The repo from settings, or the GitHub remote of the open folder. */
async function repository(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('reviewDesk').get<string>('repository')?.trim();
  if (configured) return configured;
  const git = vscode.extensions.getExtension('vscode.git');
  const api = (await git?.activate())?.getAPI(1);
  for (const repo of api?.repositories ?? []) {
    const remote = repo.state.remotes.find((r: { name: string }) => r.name === 'origin') ?? repo.state.remotes[0];
    const parsed = parseRemote(remote?.fetchUrl ?? remote?.pushUrl ?? '');
    if (parsed) return parsed;
  }
  throw new Error('Open a folder with a GitHub remote, or set "reviewDesk.repository" to owner/name.');
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
  };
  const label = vscode.workspace.getConfiguration('reviewDesk').get<string>('label')?.trim() ?? '';
  const store = { get: <T>(key: string) => context.workspaceState.get<T>(key), set: (key: string, value: unknown) => context.workspaceState.update(key, value) };
  const controller = new Controller(source, store, host, label);
  webview.onDidReceiveMessage((msg: FromWebview) => controller.handle(msg), undefined, context.subscriptions);
  panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
  webview.html = html(webview, context.extensionUri);
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.css'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><title>Review Desk</title></head>
<body><div id="app"></div><div id="toast" class="toast" role="status"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
