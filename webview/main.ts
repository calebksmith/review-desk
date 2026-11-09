import DOMPurify from 'dompurify';
import { conversationCounts, startedAt } from '../src/conversation';
import type { CheckRun, Comment, ConversationItem, DiffLine, FromWebview, HostState, MergeMethod, PrDetail, PrSummary, ReviewVerdict, ToWebview } from '../src/protocol';
import { bulkMergeable, isDependabot, mergeBlocker, mergeReadiness, mergeWarning, plural as count, prStatus, type Bucket, type Tone } from '../src/status';

// The webview only renders. Everything it knows comes from the host's state messages;
// what it remembers on its own is view state (filter, step, open file).

interface VsCodeApi { postMessage(msg: FromWebview): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Filter = 'all' | Bucket;
type Sort = 'needs' | 'updated';
type About = 'desc' | 'conv';
interface View { filter: Filter; sort: Sort; step: 'checks' | 'review'; file: string | null; onlyNew: boolean; pr: number | null; sel: number; method: MergeMethod | null; keys: boolean; about: About; aboutOpen: boolean }

let host: HostState | null = null;
let view: View = { filter: 'all', sort: 'needs', step: 'review', file: null, onlyNew: false, pr: null, sel: 0, method: null, about: 'desc', aboutOpen: false, ...(vscode.getState() as Partial<View> | undefined), keys: false };
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
  alert: svg('M12 4l9 16H3zM12 10v4M12 17h.01'),
  com: svg('M4 5h16v11H9l-5 4z'),
  minus: svg('M6 12h12'),
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
const bucket = (p: PrSummary): Bucket => prStatus(p).bucket;
function urgency(p: PrSummary): number {
  const s = prStatus(p);
  return { needs: s.tone === 'bad' ? 0 : 1, approved: 2, waiting: 3, merged: 9 }[s.bucket];
}
const PILL: Record<Tone, string> = { ok: 'ok', warn: 'need', bad: 'bad', run: 'run', muted: '' };

function checksGlyph(p: PrSummary): string {
  const c = p.checks;
  if (!c.total) return '<span class="cs none">No checks</span>';
  if (c.failed) return `<span class="cs bad">${I.x}${c.failed} failed</span>`;
  if (c.pending) return `<span class="cs run">${I.clock}${c.pending} running</span>`;
  return `<span class="cs ok">${I.check}${c.passed}/${c.total}</span>`;
}

/** The one status label for a PR. The queue, the header and the sidebar all use it. */
function statusPill(p: PrSummary): string {
  const s = prStatus(p);
  return `<span class="pill ${PILL[s.tone]}">${esc(s.label)}</span>`;
}

function visibleQueue(h: HostState): PrSummary[] {
  return h.queue
    .filter((p) => view.filter === 'all' || bucket(p) === view.filter)
    .sort(view.sort === 'needs' ? (a, b) => urgency(a) - urgency(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function queue(h: HostState): string {
  const counts: Record<Filter, number> = { all: h.queue.length, needs: 0, waiting: 0, approved: 0, merged: 0 };
  h.queue.forEach((p) => counts[bucket(p)]++);
  const rows = visibleQueue(h);
  if (view.sel >= rows.length) view.sel = Math.max(0, rows.length - 1);
  const f = (k: Filter, label: string) => `<button data-filter="${k}" aria-pressed="${view.filter === k}">${label} <span class="n">${counts[k]}</span></button>`;
  const list = rows.map((p, i) => `<button class="qrow ${i === view.sel ? 'sel' : ''}" data-open="${p.number}">
      <span class="num">#${p.number}</span>
      <span class="t"><b>${esc(p.title)}</b><span class="sub"><span class="diffstat"><span class="a">+${p.additions}</span> <span class="d">−${p.deletions}</span></span><span>${esc(p.author)}</span></span></span>
      ${checksGlyph(p)}<span class="st">${statusPill(p)}</span><span class="when">${ago(p.updatedAt)}</span>${I.chev}</button>`).join('');
  const empty = h.loading ? '<div class="empty"><span class="spin"></span>Loading pull requests</div>' : `<div class="empty">${I.check}No pull requests here</div>`;
  return `<div class="crumb"><span class="home cur">${I.inbox}Review queue</span><span class="repo">${esc(h.repo)}</span>${h.sample ? '<span class="chip">Sample data</span>' : ''}<div class="end">${bulkButton(h)}<button class="btn" data-do="refresh" aria-label="Refresh">${I.rerun}Refresh</button></div></div>
    ${h.notice ? `<div class="note" role="status">${I.check}<span>${esc(h.notice)}</span><button class="btn sm" data-do="dismissNotice">Dismiss</button></div>` : ''}
    <div class="pad">
      <div class="toolbar"><div class="seg" role="group" aria-label="Filter">${f('all', 'All')}${f('needs', 'Needs you')}${f('waiting', 'Waiting on author')}${f('approved', 'Approved')}${f('merged', 'Merged')}</div>
        <label class="sort"><span class="lbl">Sort</span><select id="sort" aria-label="Sort"><option value="needs" ${view.sort === 'needs' ? 'selected' : ''}>Needs you first</option><option value="updated" ${view.sort === 'updated' ? 'selected' : ''}>Recently updated</option></select></label></div>
      <div class="list">${list || empty}</div>
      <span class="hint"><kbd>j</kbd><kbd>k</kbd> move <kbd>Enter</kbd> open <kbd>?</kbd> all shortcuts</span>
    </div>`;
}

/** One click for the Dependabot updates that are safe to merge without opening: no conflicts, checks passed. */
function bulkButton(h: HostState): string {
  if (h.busy === 'bulk' && h.bulk) return `<button class="btn pri" disabled><span class="spin"></span>Merging ${h.bulk.done + 1} of ${h.bulk.total}</button>`;
  const ready = bulkMergeable(h.queue);
  if (!ready.length) return '';
  const held = h.queue.filter((p) => isDependabot(p) && p.state === 'open' && !ready.includes(p)).length;
  const tip = `Approves and merges ${ready.map((p) => `#${p.number}`).join(', ')}, one at a time.${held ? ` ${count(held, 'other Dependabot update')} ${held === 1 ? 'has' : 'have'} conflicts or failing checks; open ${held === 1 ? 'it' : 'them'} to review.` : ''}`;
  return `<button class="btn pri" data-do="mergeDependabot" title="${esc(tip)}" ${h.busy ? 'disabled' : ''}>${I.merge}Merge ${count(ready.length, 'Dependabot update')}</button>`;
}

/* ---------- PR ---------- */
function crumb(pr: PrDetail, h: HostState): string {
  let act: string;
  if (pr.state === 'merged') act = `<span role="status">${statusPill(pr)}</span>`;
  else if (pr.myReview !== 'approved') act = `<button class="btn pri" data-do="approve" ${h.busy ? 'disabled' : ''}>${h.busy === 'approve' ? '<span class="spin"></span>' : I.check}Approve</button>`;
  else {
    const blocker = mergeBlocker(pr);
    const method = view.method && pr.mergeMethods.includes(view.method) ? view.method : pr.mergeMethods[0]!;
    const verb = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }[method];
    const pick = pr.mergeMethods.length > 1 ? `<select id="method" aria-label="Merge method">${pr.mergeMethods.map((m) => `<option value="${m}" ${m === method ? 'selected' : ''}>${{ squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' }[m]}</option>`).join('')}</select>` : '';
    // With a check failing, Merge stays available but stops being the primary action and says "anyway".
    const warning = !blocker && mergeWarning(pr);
    act = `${pick}<button class="btn ${warning ? '' : 'pri'}" data-do="merge" data-method="${method}" ${h.busy || blocker ? 'disabled' : ''} ${blocker || warning ? `title="${esc(blocker || `${warning}. You'll be asked to confirm.`)}"` : ''}>${h.busy === 'merge' ? '<span class="spin"></span>' : I.merge}${verb}${warning ? ' anyway' : ''}</button>`;
  }
  // One line: the title truncates before anything else gives way. It's the link to GitHub.
  return `<div class="crumb prc"><button class="home" data-do="back" aria-label="Back to the review queue">${I.inbox}<span class="hl">Review queue</span></button><span class="sep" aria-hidden="true">/</span>
    <div class="pt"><span class="num">#${pr.number}</span><button class="ttl" data-ext="${esc(pr.url)}" title="${esc(pr.title)} (open on GitHub)"><b>${esc(pr.title)}</b>${I.ext}</button><span class="diffstat"><span class="a">+${pr.additions}</span> <span class="d">−${pr.deletions}</span></span></div>
    <div class="end">${act}</div></div>${pr.state === 'merged' ? '' : readiness(pr, h)}`;
}

/** The strip under the header: what stands between this PR and a merge. */
function readiness(pr: PrDetail, h: HostState): string {
  const icon: Record<Tone, string> = { ok: I.check, bad: I.x, warn: I.alert, run: '<span class="spin sm"></span>', muted: I.minus };
  const items = mergeReadiness(pr).map((it) => {
    const act = it.action === 'updateBranch' ? `<button class="btn sm" data-do="updateBranch" ${h.busy ? 'disabled' : ''}>${h.busy === 'update' ? '<span class="spin sm"></span>' : ''}Update branch</button>`
      : it.action === 'showChecks' ? `<button class="link" data-step="checks">Show</button>`
      : it.action === 'openThreads' ? `<button class="link" data-do="threads">Show</button>` : '';
    return `<span class="it ${it.tone}">${icon[it.tone]}${esc(it.text)}</span>${act}`;
  }).join('');
  // Say why Merge is off where it can be read, not only in the disabled button's tooltip.
  const blocker = pr.myReview === 'approved' ? mergeBlocker(pr) : null;
  return `<div class="ready" aria-label="Can it merge"><span class="lbl">Can it merge</span>${items}${blocker ? `<span class="why">${esc(blocker)}</span>` : ''}</div>`;
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
  const status = prStatus(pr).label;
  const glyph = { done: I.check, fail: I.x, run: '', now: '' } as const;
  const step = (k: View['step'], label: string, cls: keyof typeof glyph, sub: string) =>
    `<li class="step ${cls}"><button class="stepbtn" data-step="${k}" aria-current="${view.step === k ? 'step' : 'false'}"><span class="sd" aria-hidden="true">${glyph[cls]}</span><span class="sl"><span>${label}</span><span class="sub">${sub}</span></span></button></li>`;
  return `<aside class="side" aria-label="Review steps">
    <div class="grp"><span class="lbl">Automated</span><ol class="steps">${step('checks', 'Checks', c.cls, c.sub)}</ol></div>
    <div class="grp"><span class="lbl">You</span><ol class="steps">${step('review', 'Your review', reviewDone ? 'done' : 'now', !reviewDone && unviewed ? `${status} · ${plural(unviewed, 'file')} to read` : status)}</ol></div></aside>`;
}

function stepChecks(pr: PrDetail): string {
  const c = checksState(pr);
  const order = (r: CheckRun) => (isFail(r) ? 0 : r.status !== 'completed' ? 1 : 2);
  const runs = [...pr.checkRuns].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const pill = c.cls === 'fail' ? `<span class="oc bad">${c.sub}, blocks merge</span>` : c.cls === 'run' ? `<span class="oc run">${c.sub}</span>` : '<span class="oc ok">All passed</span>';
  const line = c.cls === 'fail' ? 'Read what failed before you approve. You can still merge anyway; Review Desk asks first.' : c.cls === 'run' ? 'Some checks are still running. This updates when you refresh.' : 'Every check passed on the latest commit.';
  const rows = runs.map((r) => {
    const g = isFail(r) ? `<span class="g bad">${I.x}</span>` : r.status !== 'completed' ? '<span class="g run"><span class="spin sm"></span></span>' : `<span class="g ok">${I.check}</span>`;
    const why = isFail(r) && (r.failedStep || r.excerpt) ? `<div class="cgb">${r.failedStep ? `<span class="fstep">Failed at <b>${esc(r.failedStep)}</b></span>` : ''}${r.excerpt ? `<pre class="log">${r.excerpt.map(esc).join('\n')}</pre>` : ''}</div>` : '';
    return `<div class="cg ${isFail(r) ? 'bad' : ''}"><div class="cgh">${g}<span class="nm">${esc(r.name)}</span><span class="tool">${esc(r.app)}</span>
      <span class="res">${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}${r.url ? `<button class="btn sm" data-ext="${esc(r.url)}">${isFail(r) ? 'Open log' : 'Details'}${I.ext}</button>` : ''}</span></div>${why}</div>`;
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
    ${about(pr)}
    <div class="split"><nav class="files" aria-label="Changed files"><div class="fh"><span class="lbl">Files</span><span class="cnt">${seen}/${files.length} viewed</span></div>${flist}<span class="hint"><kbd>n</kbd><kbd>p</kbd> next file <kbd>v</kbd> viewed</span></nav>
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

/* ---------- Description and conversation ---------- */
const COLLAPSED_ITEMS = 2;

/** What the PR is for and what people said about it, above the diff. Collapsed, it shows the start. */
function about(pr: PrDetail): string {
  const n = conversationCounts(pr.conversation);
  const conv = view.about === 'conv';
  const tab = (k: About, label: string) => `<button role="tab" data-about="${k}" aria-selected="${view.about === k}" aria-pressed="${view.about === k}">${label}</button>`;
  const fresh = n.fresh ? ` <span class="newtag">${n.fresh} new</span>` : '';
  const more = view.aboutOpen ? 'Show less' : conv ? `Show all ${n.comments}` : 'Show full description';
  const canMore = conv ? pr.conversation.length > COLLAPSED_ITEMS || view.aboutOpen : true;
  return `<section class="about" aria-label="About this pull request"><div class="abh">
      <div class="seg" role="tablist" aria-label="About this pull request">${tab('desc', 'Description')}${tab('conv', `Conversation <span class="n">${n.comments}</span>${fresh}`)}</div>
      ${conv && n.unresolved ? `<span class="it warn">${I.alert}${plural(n.unresolved, 'unresolved thread')}</span>` : ''}
      ${canMore ? `<button class="link more" data-do="about" aria-expanded="${view.aboutOpen}">${more}</button>` : ''}</div>
    <div class="abb ${view.aboutOpen ? 'open' : 'clamp'}" role="tabpanel">${conv ? conversation(pr.conversation) : description(pr)}</div></section>`;
}

function description(pr: PrDetail): string {
  return pr.bodyHtml.trim() ? `<div class="md">${safe(pr.bodyHtml)}</div>` : '<p class="none">The author didn’t write a description.</p>';
}

/** Newest first, so what changed lately is on top. Collapsed, only the latest few show. */
function conversation(items: ConversationItem[]): string {
  if (!items.length) return '<p class="none">No comments yet.</p>';
  const newest = [...items].sort((a, b) => Date.parse(startedAt(b)) - Date.parse(startedAt(a)));
  return (view.aboutOpen ? newest : newest.slice(0, COLLAPSED_ITEMS)).map(convItem).join('');
}

const VERDICT: Record<ReviewVerdict, string> = {
  approved: '<span class="pill ok">Approved</span>', changes_requested: '<span class="pill need">Changes requested</span>',
  commented: '<span class="pill">Reviewed</span>', dismissed: '<span class="pill">Dismissed</span>',
};

function convItem(it: ConversationItem): string {
  if (it.kind !== 'thread') return `<article class="ci">${comment(it.comment, it.kind === 'review' ? VERDICT[it.verdict] : '')}</article>`;
  const where = `${base(it.path)}${it.line ? `:${it.line}` : ''}`;
  const state = it.resolved ? '<span class="pill">Resolved</span>' : '<span class="pill need">Unresolved</span>';
  return `<article class="ci thread"><div class="cih">${I.com}<button class="link mono" data-file="${esc(it.path)}" title="Show ${esc(it.path)} in the diff">${esc(where)}</button>${state}${it.outdated ? '<span class="pill">Outdated</span>' : ''}</div>
    ${it.comments.map((c) => comment(c, '')).join('')}</article>`;
}

function comment(c: Comment, badge: string): string {
  return `<div class="cm ${c.isNew ? 'new' : ''}"><div class="cmh"><b>${esc(c.author)}</b>${badge}<span class="when">${ago(c.createdAt)} ago</span>${c.isNew ? '<span class="newtag">New</span>' : ''}
    <button class="link gh" data-ext="${esc(c.url)}" aria-label="Open this comment on GitHub">${I.ext}</button></div>${c.html.trim() ? `<div class="md">${safe(c.html)}</div>` : ''}</div>`;
}

/** GitHub's rendered HTML, cleaned before it's shown. No ids or classes, so it can't restyle or clash with the panel. */
const cleaned = new Map<string, string>();
function safe(html: string): string {
  let out = cleaned.get(html);
  if (out === undefined) {
    out = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style', 'id', 'class', 'name'] });
    cleaned.set(html, out);
  }
  return out;
}

/** Hides "Show full description" when the description already fits. */
function fitAbout(): void {
  const box = app.querySelector<HTMLElement>('.abb.clamp');
  if (!box || view.about !== 'desc') return;
  if (box.scrollHeight <= box.clientHeight + 1) {
    box.classList.remove('clamp');
    app.querySelector<HTMLElement>('.about .more')?.remove();
  }
}

function prView(h: HostState): string {
  const pr = h.pr;
  if (!pr) return `<div class="crumb"><button class="home" data-do="back">${I.inbox}Review queue</button></div><div class="empty"><span class="spin"></span>Loading pull request</div>`;
  return `${crumb(pr, h)}<div class="cols">${sidebar(pr)}<main>${view.step === 'checks' ? stepChecks(pr) : stepReview(pr)}</main></div>`;
}

function render(): void {
  if (!host) return;
  const err = host.error ? `<div class="err" role="alert">${esc(host.error)}<button class="btn sm" data-do="refresh">Try again</button></div>` : '';
  app.innerHTML = err + (host.view === 'pr' ? prView(host) : queue(host)) + (view.keys ? keysHelp() : '');
  fitAbout();
}

function keysHelp(): string {
  const r = (ks: string[], t: string) => `<div class="kr">${ks.map((k) => `<kbd>${k}</kbd>`).join('')}<span>${t}</span></div>`;
  return `<div class="keys" data-do="keys"><div class="kp" role="dialog" aria-label="Keyboard shortcuts"><b>Keyboard shortcuts</b>
    <span class="lbl">Queue</span>${r(['j', 'k'], 'Move down or up')}${r(['Enter'], 'Open the pull request')}${r(['r'], 'Refresh')}
    <span class="lbl">Pull request</span>${r(['j', 'k'], 'Next or previous pull request')}${r(['n', 'p'], 'Next or previous file')}${r(['v'], 'Toggle viewed on this file')}${r(['d'], 'Show or hide the full description')}${r(['1', '2'], 'Checks, Your review')}${r(['a'], 'Approve')}${r(['Esc'], 'Back to the queue')}${r(['?'], 'Show or hide this list')}</div></div>`;
}

/* ---------- Events ---------- */
window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  if (msg.type === 'state') {
    const pr = msg.state.pr;
    if (pr && pr.number !== view.pr) {
      // Open on the conversation when there's something new in it; otherwise on the description.
      view = { ...view, pr: pr.number, file: null, onlyNew: false, step: 'review', about: conversationCounts(pr.conversation).fresh ? 'conv' : 'desc', aboutOpen: false };
      vscode.setState(view);
    }
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
  else if (t.id === 'method') save({ method: t.value as MergeMethod });
  else if (t instanceof HTMLInputElement && t.dataset.viewed) send({ type: 'setViewed', path: t.dataset.viewed, viewed: t.checked });
});

document.addEventListener('click', (e) => {
  // Links inside descriptions and comments open in the browser, never inside the panel.
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.md a[href]');
  if (a) {
    e.preventDefault();
    if (/^https?:/.test(a.href)) send({ type: 'openExternal', url: a.href });
    return;
  }
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open],[data-filter],[data-step],[data-about],[data-file],[data-onlynew],[data-line],[data-ext],[data-do]');
  if (!t || (t as HTMLButtonElement).disabled) return;
  const d = t.dataset;
  if (d.open) send({ type: 'openPr', number: Number(d.open) });
  else if (d.filter) save({ filter: d.filter as Filter });
  else if (d.step) save({ step: d.step as View['step'] });
  else if (d.about) save({ about: d.about as About });
  else if (d.file) save({ file: d.file, step: 'review', onlyNew: d.onlynew === '1' });
  else if (d.onlynew) save({ onlyNew: d.onlynew === '1' });
  else if (d.line && view.file) send({ type: 'openFile', path: view.file, line: Number(d.line) });
  else if (d.ext) send({ type: 'openExternal', url: d.ext });
  else if (d.do === 'back') send({ type: 'back' });
  else if (d.do === 'refresh') send({ type: 'refresh' });
  else if (d.do === 'approve') send({ type: 'approve' });
  else if (d.do === 'merge') send({ type: 'merge', method: (d.method as MergeMethod | undefined) ?? 'merge' });
  else if (d.do === 'updateBranch') send({ type: 'updateBranch' });
  else if (d.do === 'keys') save({ keys: false });
  else if (d.do === 'about') save({ aboutOpen: !view.aboutOpen });
  else if (d.do === 'mergeDependabot') send({ type: 'mergeDependabot' });
  else if (d.do === 'dismissNotice') send({ type: 'dismissNotice' });
  else if (d.do === 'threads') save({ step: 'review', about: 'conv', aboutOpen: true });
});

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (!host || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const k = e.key;
  if (k === '?') { save({ keys: !view.keys }); return; }
  if (view.keys) { if (k === 'Escape') save({ keys: false }); return; }
  const rows = visibleQueue(host);
  if (host.view === 'queue') {
    if (k === 'j' || k === 'ArrowDown') { save({ sel: Math.min(rows.length - 1, view.sel + 1) }); e.preventDefault(); }
    else if (k === 'k' || k === 'ArrowUp') { save({ sel: Math.max(0, view.sel - 1) }); e.preventDefault(); }
    else if (k === 'Enter' && rows[view.sel] && !(e.target as HTMLElement).closest('button')) send({ type: 'openPr', number: rows[view.sel]!.number });
    else if (k === 'r') send({ type: 'refresh' });
    return;
  }
  const pr = host.pr;
  if (!pr) return;
  if (k === 'Escape') send({ type: 'back' });
  else if (k === 'j' || k === 'k') {
    if (!rows.length) return;
    const at = rows.findIndex((p) => p.number === pr.number);
    const next = rows[(at + (k === 'j' ? 1 : -1) + rows.length) % rows.length]!;
    view.sel = rows.indexOf(next);
    send({ type: 'openPr', number: next.number });
  } else if (k === 'n' || k === 'p') {
    const i = Math.max(0, pr.files.findIndex((f) => f.path === view.file));
    const f = pr.files[Math.min(pr.files.length - 1, Math.max(0, i + (k === 'n' ? 1 : -1)))];
    if (f) save({ file: f.path, step: 'review', onlyNew: false });
  } else if (k === 'v' && view.step === 'review' && view.file) {
    const f = pr.files.find((x) => x.path === view.file);
    if (f) send({ type: 'setViewed', path: f.path, viewed: f.viewed !== 'viewed' });
  } else if (k === 'd') save({ step: 'review', about: 'desc', aboutOpen: view.step !== 'review' || view.about !== 'desc' || !view.aboutOpen });
  else if (k === '1') save({ step: 'checks' });
  else if (k === '2') save({ step: 'review' });
  else if (k === 'a' && pr.state !== 'merged' && pr.myReview !== 'approved') send({ type: 'approve' });
});

send({ type: 'ready' });
