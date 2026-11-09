import { Controller } from '../src/controller';
import type { FromWebview } from '../src/protocol';
import { SampleSource } from '../src/sample';

// Stands in for VS Code in a plain browser: the real controller runs on sample data,
// so the preview page shows exactly what the extension would.

const store = new Map<string, unknown>();
let state: unknown;
const controller = new Controller(new SampleSource(), { get: <T>(k: string) => store.get(k) as T | undefined, set: (k, v) => { store.set(k, v); } }, {
  post: (msg) => window.postMessage(msg, '*'),
  openFile: (path, line) => console.log('openFile', path, line),
  openExternal: (url) => console.log('openExternal', url),
  confirm: async () => true,
});

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (msg: FromWebview) => { void controller.handle(msg); },
  getState: () => state,
  setState: (s: unknown) => { state = s; },
});
