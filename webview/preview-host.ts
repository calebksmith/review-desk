import { Controller } from '../src/controller';
import type { FromWebview } from '../src/protocol';
import { SampleSource } from '../src/sample';

// Stands in for VS Code in a plain browser: the real controller runs on sample data,
// so the preview page shows exactly what the extension would.

const store = new Map<string, unknown>();
// #55 was last opened 30 minutes ago, so its newer comments show as new.
store.set('lastSeenAt:calebksmith/portfolio#55', new Date(Date.now() - 30 * 60_000).toISOString());
// #59 was opened an hour ago, after Codex's finding: nothing is new, but the finding is still open.
store.set('lastSeenAt:calebksmith/portfolio#59', new Date(Date.now() - 60 * 60_000).toISOString());
// #58 has a suggestion from your agent, as if Review with agent had run.
store.set('drafts:calebksmith/portfolio#58', [{ id: 'A_58_1', path: 'src/app/work/page.tsx', line: 23, side: 'RIGHT', from: 'agent', severity: 2,
  body: 'Only the first study passes `first`, but the grid shows two images per row on wide screens. The second one is above the fold too.' }]);
let state: unknown;
// ?sample=team shows a team: several developers, stacked PRs and required approvals.
const team = new URLSearchParams(location.search).get('sample') === 'team';
const controller = new Controller(new SampleSource(team ? 'team' : 'solo'), { get: <T>(k: string) => store.get(k) as T | undefined, set: (k, v) => { store.set(k, v); } }, {
  post: (msg) => window.postMessage(msg, '*'),
  openFile: (path, line) => console.log('openFile', path, line),
  openExternal: (url) => console.log('openExternal', url),
  confirm: async () => true,
  askAgent: async (prompt) => { console.log(prompt); return 'clipboard'; },
  choose: async (title, options) => { console.log(title, options); return options[0]; },
  switchRepository: () => console.log('switchRepository'),
  findingsFile: async () => null,
}, '', [{ label: 'Ask Codex to review', comment: '@codex review', reviewer: 'chatgpt-codex-connector' }]);

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (msg: FromWebview) => { void controller.handle(msg); },
  getState: () => state,
  setState: (s: unknown) => { state = s; },
});

// In the preview only: try host-side things by hand, e.g. reviewDesk.importFindings({ repo, number }, [...]).
(window as unknown as { reviewDesk: Controller }).reviewDesk = controller;
