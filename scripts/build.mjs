import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };
// The panel shows which build it is, so a reviewer can tell an update took.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));

if (production) await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('webview/styles.css', 'dist/webview.css');

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome114', define: { __VERSION__: JSON.stringify(version) } },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
