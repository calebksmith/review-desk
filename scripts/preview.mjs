import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Builds .preview/index.html: the webview on sample data, with VS Code's Light+ or Dark+ colors.
// Open it in a browser (?theme=dark for dark) to see the UI without VS Code.

const light = { 'editor-background': '#ffffff', 'sideBar-background': '#f3f3f3', 'panel-border': '#e0e0e0', foreground: '#3b3b3b', descriptionForeground: '#6c6c6c',
  'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b',
  'textLink-foreground': '#005fb8', focusBorder: '#005fb8', 'testing-iconPassed': '#388a34', 'testing-iconFailed': '#c72e0f', 'editorWarning-foreground': '#bf8803',
  'diffEditor-insertedLineBackground': 'rgba(155,185,85,.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,.12)', 'input-background': '#ffffff' };
const dark = { 'editor-background': '#1f1f1f', 'sideBar-background': '#181818', 'panel-border': '#2b2b2b', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
  'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc',
  'textLink-foreground': '#4daafc', focusBorder: '#0078d4', 'testing-iconPassed': '#73c991', 'testing-iconFailed': '#f14c4c', 'editorWarning-foreground': '#cca700',
  'diffEditor-insertedLineBackground': 'rgba(155,185,85,.2)', 'diffEditor-removedLineBackground': 'rgba(255,0,0,.2)', 'input-background': '#313131' };
const vars = (o) => Object.entries(o).map(([k, v]) => `--vscode-${k}:${v}`).join(';');

const host = await esbuild.build({ entryPoints: ['webview/preview-host.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const app = await readFile('dist/webview.js', 'utf8');
const css = await readFile('dist/webview.css', 'utf8');
await mkdir('.preview', { recursive: true });
// The same rules as the extension's CSP (no inline styles or scripts beyond these tagged ones), so anything the
// webview would refuse inside VS Code, like a style="" attribute, is refused here too.
const nonce = 'preview';
const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src https: data:;`;
await writeFile('.preview/index.html', `<!doctype html><html><head><meta charset="utf-8"><title>Review Desk preview</title>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">:root{${vars(light)};--vscode-font-family:-apple-system,"Segoe UI",system-ui,sans-serif;--vscode-editor-font-family:Menlo,Consolas,monospace}
:root.dark{${vars(dark)}}${css}</style></head><body><div id="app"></div><div id="toast" class="toast" role="status"></div>
<script nonce="${nonce}">if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')</script>
<script nonce="${nonce}">${host.outputFiles[0].text}</script><script nonce="${nonce}">${app}</script></body></html>`);
console.log('Wrote .preview/index.html');
