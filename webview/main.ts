import type { CheckRun, DiffLine, FileDiff, FromWebview, HostState, PrDetail, PrSummary, ToWebview } from '../src/protocol';

// The webview only renders. Everything it knows comes from the host's state messages;
// what it remembers on its own is view state (filter, step, open file).

interface VsCodeApi { postMessage(msg: FromWebview): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Filter = 'all' | 'needs' | 'approved' | 'merged';
type Sort = 'needs' | 'updated';
interface View { filter: Filter; sort: Sort; step: 'checks' | 'review'; file: string | null; onlyNew: boolean; pr: number | null }

let host: HostState | null = null;
let view: View = { filter: 'all', sort: 'needs', step: 'review', file: null, onlyNew: false, pr: null, ...(vscode.getState() as Partial<View> | undefined) };
const send = (msg: FromWebview) => vscode.postMessage(msg);
const app = document.getElementById('app')!;

/* ---------- Icons (Heroicons outline paths) ---------- */
const svg = (d: string, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const I = {
  check: svg('M5 12l5 5L19 7'),
  x: svg('M6 6l12 12M18 6L6 18'),
  dot: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
  chev: svg('M9 6l6 6-6 6'),
  back: svg('M15 6l-6 6 6 6'),
  inbox: svg('M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z'),
  rerun: svg('M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4'),
  ext: svg('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  merge: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 7c0 3 3 5 10 5"/></svg>',
  you: svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'),
  clock: svg('M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'),
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 60 / 24)}d`;
}

function save(patch: Partial<View>): void {
  view = { ...view, ...patch };
  vscode.setState(view);
  render();
}

/* ---------- Queue ---------- */
function bucket(p: PrSummary): Exclude<Filter, 'all'> {
  if (p.state === 'merged') return 'merged';
  return p.myReview === 'approved' ? 'approved' : 'needs';
}
function urgency(p: PrSummary): number {
  if (p.state === 'merged') return 9;
  if (p.myReview === 'approved') return 5;
  if (p.isDraft) return 4;
  return p.checks.failed ? 1 : 0;
}

function checksGlyph(p: PrSummary): string {
  const c = p.checks;
  if (!c.total) return '<span class="cs none">No checks</span>';
  if (c.failed) return `<span class="cs bad">${I.x}${c.failed} failed</span>`;
  if (c.pending) return `<span class="cs run">${I.clock}${c.pending} running</span>`;
  return `<span class="cs ok">${I.check}${c.passed}/${c.total}</span>`;
}

function statusPill(p: PrSummary): string {
  if (p.state === 'merged') return '<span class="pill">Merged</span>';
  if (p.myReview === 'approved') return '<span class="pill ok">Approved</span>';
  if (p.isDraft) return '<span class="pill">Draft</span>';
  return '<span class="pill need">Needs you</span>';
}

function queue(h: HostState): string {
  const counts = { all: h.queue.length, needs: 0, approved: 0, merged: 0 };
  h.queue.forEach((p) => counts[bucket(p)]++);
  const rows = h.queue
    .filter((p) => view.filter === 'all' || bucket(p) === view.filter)
    .sort(view.sort === 'needs' ? (a, b) => urgency(a) - urgency(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const f = (k: Filter, label: string) => `<button data-filter="${k}" aria-pressed="${view.filter === k}">${label} <span class="n">${counts[k]}</span></button>`;
  const list = rows.map((p) => `<button class="qrow" data-open="${p.number}">
      <span class="num">#${p.number}</span>
      <span class="t"><b>${esc(p.title)}</b><span class="sub"><span class="diffstat"><span class="a">+${p.additions}</span> <span class="d">−${p.deletions}</span></span><span>${esc(p.author)}</span></span></span>
      ${checksGlyph(p)}<span class="st">${statusPill(p)}</span><span class="when">${ago(p.updatedAt)}</span>${I.chev}</button>`).join('');
  const empty = h.loading ? '<div class="empty"><span class="spin"></span>Loading pull requests</div>' : `<div class="empty">${I.check}No pull requests here</div>`;
  return `<div class="crumb"><span class="home cur">${I.inbox}Review queue</span><span class="repo">${esc(h.repo)}</span>${h.sample ? '<span class="chip">Sample data</span>' : ''}<div class="end"><button class="btn" data-do="refresh" aria-label="Refresh">${I.rerun}Refresh</button></div></div>
    <div class="pad">
      <div class="toolbar"><div class="seg" role="group" aria-label="Filter">${f('all', 'All')}${f('needs', 'Needs you')}${f('approved', 'Approved')}${f('merged', 'Merged')}</div>
        <label class="sort"><span class="lbl">Sort</span><select id="sort" aria-label="Sort"><option value="needs" ${view.sort === 'needs' ? 'selected' : ''}>Needs you first</option><option value="updated" ${view.sort === 'updated' ? 'selected' : ''}>Recently updated</option></select></label></div>
      <div class="list">${list || empty}</div>
    </div>`;
}

/* ---------- PR ---------- */
function crumb(pr: PrDetail, h: HostState): string {
  const seen = pr.files.filter((f) => f.viewed === 'viewed').length;
  const viewed = `<span class="stat ${seen === pr.files.length ? 'ok' : ''}" role="status">${seen} of ${plural(pr.files.length, 'file')} viewed</span>`;
  let act: string;
  if (pr.state === 'merged') act = '<span class="stat ok">Merged</span>';
  else if (pr.myReview !== 'approved') act = `${viewed}<button class="btn pri" data-do="approve" ${h.busy ? 'disabled' : ''}>${h.busy === 'approve' ? '<span class="spin"></span>' : I.check}Approve</button>`;
  else act = `<span class="stat ok">Approved</span><button class="btn pri" data-do="merge" ${h.busy || pr.mergeable === false ? 'disabled' : ''} ${pr.mergeable === false ? 'title="Resolve the merge conflict on GitHub first"' : ''}>${h.busy === 'merge' ? '<span class="spin"></span>' : I.merge}Merge</button>`;
  return `<div class="crumb"><button class="home" data-do="back">${I.inbox}Review queue</button><span class="sep" aria-hidden="true">/</span>
    <div class="pt"><span class="num">#${pr.number}</span><b>${esc(pr.title)}</b><span class="diffstat"><span class="a">+${pr.additions}</span> <span class="d">−${pr.deletions}</span></span><button class="link" data-ext="${esc(pr.url)}">${I.ext}GitHub</button></div>
    <div class="end">${act}</div></div>`;
}

function checksState(pr: PrDetail): { cls: 'done' | 'fail' | 'run'; sub: string } {
  const runs = pr.checkRuns;
  const failed = runs.filter((r) => isFail(r)).length;
  const running = runs.filter((r) => r.status !== 'completed').length;
  if (failed) return { cls: 'fail', sub: `${failed} failed` };
  if (running) return { cls: 'run', sub: `${running} running` };
  return { cls: 'done', sub: runs.length ? `${runs.length}/${runs.length} passed` : 'No checks' };
}
const isFail = (r: CheckRun) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'].includes(r.conclusion ?? '');

function sidebar(pr: PrDetail): string {
  const c = checksState(pr);
  const reviewDone = pr.state === 'merged' || pr.myReview === 'approved';
  const unviewed = pr.files.filter((f) => f.viewed !== 'viewed').length;
  const glyph = { done: I.check, fail: I.x, run: '', now: '' } as const;
  const step = (k: View['step'], label: string, cls: keyof typeof glyph, sub: string) =>
    `<li class="step ${cls}"><button class="stepbtn" data-step="${k}" aria-current="${view.step === k ? 'step' : 'false'}"><span class="sd" aria-hidden="true">${glyph[cls]}</span><span class="sl"><span>${label}</span><span class="sub">${sub}</span></span></button></li>`;
  return `<aside class="side" aria-label="Review steps">
    <div class="grp"><span class="lbl">Automated</span><ol class="steps">${step('checks', 'Checks', c.cls, c.sub)}</ol></div>
    <div class="grp"><span class="lbl">You</span><ol class="steps">${step('review', 'Your review', reviewDone ? 'done' : 'now', pr.state === 'merged' ? 'Merged' : reviewDone ? 'Approved' : unviewed ? `${plural(unviewed, 'file')} to read` : 'Ready to approve')}</ol></div></aside>`;
}

function stepChecks(pr: PrDetail): string {
  const c = checksState(pr);
  const order = (r: CheckRun) => (isFail(r) ? 0 : r.status !== 'completed' ? 1 : 2);
  const runs = [...pr.checkRuns].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const pill = c.cls === 'fail' ? `<span class="oc open">${c.sub}</span>` : c.cls === 'run' ? `<span class="oc run">${c.sub}</span>` : '<span class="oc ok">All passed</span>';
  const line = c.cls === 'fail' ? 'Read what failed before you approve. Required checks still hold the merge on GitHub.' : c.cls === 'run' ? 'Some checks are still running. This updates when you refresh.' : 'Every check passed on the latest commit.';
  const rows = runs.map((r) => {
    const g = isFail(r) ? `<span class="g bad">${I.x}</span>` : r.status !== 'completed' ? '<span class="g run"><span class="spin sm"></span></span>' : `<span class="g ok">${I.check}</span>`;
    return `<div class="cg ${isFail(r) ? 'bad' : ''}"><div class="cgh">${g}<span class="nm">${esc(r.name)}</span><span class="tool">${esc(r.app)}</span>
      <span class="res">${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}${r.url ? `<button class="btn sm" data-ext="${esc(r.url)}">${isFail(r) ? 'Open log' : 'Details'}${I.ext}</button>` : ''}</span></div></div>`;
  }).join('');
  return `<div class="sh"><div class="tx"><h2>Checks${pill}</h2><p>${line}</p><div class="prov"><span>${esc(pr.headSha.slice(0, 7))}</span><span>${esc(pr.headRef)} → ${esc(pr.baseRef)}</span></div></div></div>
    <div class="pad">${rows || '<div class="empty">This repo runs no checks on pull requests.</div>'}</div>`;
}

function stepReview(pr: PrDetail): string {
  const files = pr.files;
  if (!view.file || !files.some((f) => f.path === view.file)) view.file = (files.find((f) => f.viewed !== 'viewed') ?? files[0])?.path ?? null;
  const file = files.find((f) => f.path === view.file);
  const seen = files.filter((f) => f.viewed === 'viewed').length;
  const since = pr.sinceLastLook;
  const changedSince = new Set(since?.files.map((f) => f.path) ?? []);
  const line = pr.state === 'merged' ? 'Merged.' : pr.myReview === 'approved' ? 'Approved. Merge from the header.' : seen < files.length ? `Read the ${plural(files.length, 'changed file')} and tick each one viewed, then approve.` : 'You’ve read every file. Approve from the header.';

  const flist = files.map((f) => {
    const isNew = changedSince.has(f.path) || f.viewed === 'changed';
    return `<div class="frow" aria-current="${view.file === f.path}">
      <input type="checkbox" class="vbox" data-viewed="${esc(f.path)}" ${f.viewed === 'viewed' ? 'checked' : ''} aria-label="Viewed ${esc(f.path)}">
      <button class="fn" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="dir">${esc(dir(f.path))}</span>${esc(base(f.path))}</button>
      ${isNew ? '<span class="newdot" title="Changed since you looked"></span>' : ''}<span class="diffstat"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span></div>`;
  }).join('');

  let lines = file?.lines ?? null;
  const fileSince = since?.files.find((f) => f.path === file?.path);
  if (view.onlyNew && fileSince) lines = fileSince.lines;
  const banner = since && pr.state !== 'merged' ? `<div class="newbar">${I.rerun}<b>${plural(since.commits, 'new commit')} since you looked</b><span class="chip">${esc(since.fromSha.slice(0, 7))}…${esc(since.toSha.slice(0, 7))}</span><span>${since.files.map((f) => esc(base(f.path))).join(', ')}</span>
    ${fileSince ? `<div class="seg"><button data-onlynew="0" aria-pressed="${!view.onlyNew}">Whole change</button><button data-onlynew="1" aria-pressed="${view.onlyNew}">Since you looked</button></div>` : since.files[0] ? `<button class="btn sm" data-file="${esc(since.files[0].path)}" data-onlynew="1">Show it${I.chev}</button>` : ''}</div>` : '';

  return `<div class="sh"><div class="tx"><h2>Your review</h2><p>${line}</p></div></div>${banner}
    ${pr.body.trim() ? `<section class="intent" aria-label="Description"><span>${esc(firstParagraph(pr.body))}</span></section>` : ''}
    <div class="split"><nav class="files" aria-label="Changed files"><div class="fh"><span class="lbl">Files</span><span class="cnt">${seen}/${files.length} viewed</span></div>${flist}</nav>
      <section class="diffpane" aria-label="Diff">${file ? `<div class="dh"><span class="mono">${esc(file.path)}</span><label class="vt"><input type="checkbox" data-viewed="${esc(file.path)}" ${file.viewed === 'viewed' ? 'checked' : ''}> Viewed</label></div>
        <div class="code">${lines ? lines.map(diffLine).join('') : '<div class="empty">GitHub sends no diff for this file. It’s binary or too large to show.</div>'}</div>` : '<div class="empty">No files changed.</div>'}</section></div>`;
}

function diffLine(l: DiffLine): string {
  if (l.kind === 'gap') return `<div class="hunk">${l.hidden ? `${plural(l.hidden, 'line')} hidden` : 'Lines hidden'}</div>`;
  const n = l.newNo ?? l.oldNo;
  const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  const num = l.newNo != null ? `<button class="n" data-line="${l.newNo}" title="Open at line ${l.newNo}">${n}</button>` : `<span class="n">${n}</span>`;
  return `<div class="ln ${l.kind}">${num}<span class="m">${mark}</span><span class="tx">${esc(l.text) || ' '}</span></div>`;
}

const base = (p: string) => p.split('/').pop() ?? p;
const dir = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
const firstParagraph = (s: string) => s.trim().split(/\n\s*\n/)[0]!.replace(/[#*_`>]/g, '').slice(0, 400);

function prView(h: HostState): string {
  const pr = h.pr;
  if (!pr) return `<div class="crumb"><button class="home" data-do="back">${I.inbox}Review queue</button></div><div class="empty"><span class="spin"></span>Loading pull request</div>`;
  return `${crumb(pr, h)}<div class="cols">${sidebar(pr)}<main>${view.step === 'checks' ? stepChecks(pr) : stepReview(pr)}</main></div>`;
}

function render(): void {
  if (!host) return;
  const err = host.error ? `<div class="err" role="alert">${esc(host.error)}<button class="btn sm" data-do="refresh">Try again</button></div>` : '';
  app.innerHTML = err + (host.view === 'pr' ? prView(host) : queue(host));
}

/* ---------- Events ---------- */
window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  if (msg.type === 'state') {
    if (msg.state.pr && msg.state.pr.number !== view.pr) { view = { ...view, pr: msg.state.pr.number, file: null, onlyNew: false, step: 'review' }; vscode.setState(view); }
    host = msg.state;
    render();
  } else if (msg.type === 'toast') {
    const t = document.getElementById('toast')!;
    t.textContent = msg.text;
    t.classList.add('show');
    clearTimeout((t as unknown as { timer?: number }).timer);
    (t as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.id === 'sort') save({ sort: t.value as Sort });
  else if (t instanceof HTMLInputElement && t.dataset.viewed) send({ type: 'setViewed', path: t.dataset.viewed, viewed: t.checked });
});

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open],[data-filter],[data-step],[data-file],[data-onlynew],[data-line],[data-ext],[data-do]');
  if (!t || (t as HTMLButtonElement).disabled) return;
  const d = t.dataset;
  if (d.open) send({ type: 'openPr', number: Number(d.open) });
  else if (d.filter) save({ filter: d.filter as Filter });
  else if (d.step) save({ step: d.step as View['step'] });
  else if (d.file) save({ file: d.file, step: 'review', onlyNew: d.onlynew === '1' });
  else if (d.onlynew) save({ onlyNew: d.onlynew === '1' });
  else if (d.line && view.file) send({ type: 'openFile', path: view.file, line: Number(d.line) });
  else if (d.ext) send({ type: 'openExternal', url: d.ext });
  else if (d.do === 'back') send({ type: 'back' });
  else if (d.do === 'refresh') send({ type: 'refresh' });
  else if (d.do === 'approve') send({ type: 'approve' });
  else if (d.do === 'merge') send({ type: 'merge' });
});

send({ type: 'ready' });
