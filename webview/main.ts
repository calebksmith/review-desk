import DOMPurify from 'dompurify';
import { duration, isFailing, isSkipped, statusCard, type PartKey } from '../src/card';
import { conversationCounts, startedAt } from '../src/conversation';
import { mergeTree, parentOf, stackOf, stacks, type StackRow, type TreeRow } from '../src/stacks';
import { inDiff } from '../src/patch';
import { parseKey, prKey } from '../src/protocol';
import type { CheckRun, Comment, CommentAction, ConversationItem, Draft, ReviewEvent, DiffLine, FromWebview, HostState, MergeMethod, PrDetail, PrSummary, ReviewVerdict, ToWebview } from '../src/protocol';
import { askAndReply, who } from '../src/refresh';
import { inMilestone, milestones, NO_MILESTONE, reasons } from '../src/signals';
import { fileMarks, nearLines, reviewQueue, stepQueue, type QueueItem } from '../src/queue';
import { bulkMergeable, isDependabot, isReReview, openFindings, priority, priorityOrder, mergeBlocker, mergeReadiness, mergeSummary, mergeWarning, plural, prStatus, stillOpen, type Bucket, type Tone } from '../src/status';

// The webview only renders. Everything it knows comes from the host's state messages;
// what it remembers on its own is view state (filter, step, open file).

interface VsCodeApi { postMessage(msg: FromWebview): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type Filter = 'all' | Bucket;
type Step = 'overview' | 'checks' | 'files';
/** The comment box open in the diff: a new comment on a line (or range), a reply to a thread, or an edit. */
interface Composer { id?: string; path: string; line: number | null; side: 'RIGHT' | 'LEFT'; startLine?: number | null; replyTo?: string; resolve?: boolean; editId?: string; prefill?: string }
type Thread = Extract<ConversationItem, { kind: 'thread' }>;
interface View { filter: Filter; step: Step; file: string | null; onlyNew: boolean; pr: string | null; sel: number; repo: string; milestone: string | null; method: MergeMethod | null; keys: boolean; showPassed: boolean; layout: 'list' | 'stacks'; reviewEvent: ReviewEvent | null; part: PartKey | null; cardOpen: boolean; conv: 'all' | 'unresolved' | 'mine'; composer: Composer | null; finding: string | null; near: boolean; menu: 'checklist' | 'methods' | 'review' | null }

let host: HostState | null = null;
/** True while the reviewer moves through the queue with j/k; a mouse move hides the cursor again. */
let kbd = false;
/** Text to put in Overview's comment box on the next render. */
let prefill: string | null = null;
let view: View = { filter: 'all', repo: '', milestone: null, reviewEvent: null, part: null, cardOpen: false, conv: 'all', composer: null, finding: null, near: false, showPassed: false, layout: 'list', step: 'overview', file: null, onlyNew: false, pr: null, sel: 0, method: null, ...(vscode.getState() as Partial<View> | undefined), keys: false, menu: null };
// State saved by older versions named the files page "review".
if (!['overview', 'checks', 'files'].includes(view.step)) view.step = 'files';
// Older versions saved a bare PR number; keys are owner/name#number now.
if (typeof view.pr !== 'string') view.pr = null;
const send = (msg: FromWebview) => vscode.postMessage(msg);
const app = document.getElementById('app')!;

/* ---------- Icons (Heroicons outline paths) ---------- */
const svg = (d: string, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const I = {
  check: svg('M5 12l5 5L19 7'),
  x: svg('M6 6l12 12M18 6L6 18'),
  dot: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
  chev: svg('M9 6l6 6-6 6'),
  prev: svg('M15 6l-6 6 6 6'),
  back: svg('M19 12H5M11 6l-6 6 6 6'),
  inbox: svg('M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z'),
  rerun: svg('M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4'),
  ext: svg('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  merge: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 7c0 3 3 5 10 5"/></svg>',
  you: svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'),
  clock: svg('M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'),
  alert: svg('M12 4l9 16H3zM12 10v4M12 17h.01'),
  com: svg('M4 5h16v11H9l-5 4z'),
  minus: svg('M6 12h12'),
  globe: svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'),
  stack: svg('M6 4v10a3 3 0 0 0 3 3h9M6 9h6M15 14l3 3-3 3'),
  down: svg('M7 10l5 5 5-5', 'ico caretico'),
  lock: svg('M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z'),
  doc: svg('M7 4h7l4 4v12H7zM14 4v4h4M10 12h5M10 16h5'),
  milestone: svg('M12 3v18M6 6h10l3 3-3 3H6z'),
  spark: svg('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z'),
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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

/** "Updated 4m ago": when what's on screen last loaded. The text ticks without redrawing the page. */
function updated(h: HostState): string {
  return h.updatedAt ? `<span class="upd" data-at="${esc(h.updatedAt)}" title="Refreshes on its own while Review Desk is open">${since(h.updatedAt)}</span>` : '';
}
function since(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 45 ? 'Updated just now' : `Updated ${ago(iso)} ago`;
}
setInterval(() => document.querySelectorAll<HTMLElement>('.upd[data-at]').forEach((el) => { el.textContent = since(el.dataset.at!); }), 15_000);

/* ---------- Queue ---------- */
/** The queue spans more than one repo: rows say which, and a number alone needs its repo. */
const multi = (h: HostState) => new Set(h.queue.map((p) => p.repo)).size > 1;
const short = (repo: string) => repo.split('/')[1] ?? repo;

const bucket = (p: PrSummary): Bucket => prStatus(p).bucket;
const PILL: Record<Tone, string> = { ok: 'ok', warn: 'need', bad: 'bad', run: 'run', muted: '' };

/** Checks as a small icon by the title, like GitHub's list; the count is in the tooltip. */
function checksIcon(p: PrSummary): string {
  const c = p.checks;
  if (!c.total) return '';
  if (c.failed) return `<span class="ci-ico bad" title="${c.failed} of ${c.total} checks failing">${I.x}</span>`;
  if (c.pending) return `<span class="ci-ico run" title="${c.pending} of ${c.total} checks running">${I.clock}</span>`;
  return `<span class="ci-ico ok" title="All ${c.total} checks passed">${I.check}</span>`;
}

/** The one status label for a PR. The queue, the header and the sidebar all use it. */
function statusPill(p: PrSummary): string {
  const s = prStatus(p);
  return `<span class="pill ${PILL[s.tone]}">${esc(s.label)}</span>`;
}

/** In lists, the usual state ("Needs your review") goes unsaid; merged reads as plain text. */
function listStatus(p: PrSummary): string {
  const s = prStatus(p);
  if (s.quiet) return s.bucket === 'merged' ? '<span class="stx">Merged</span>' : '';
  return statusPill(p);
}

/** The rows in the order they're shown, so j/k and Enter follow the screen in either layout. */
function visibleQueue(h: HostState): PrSummary[] {
  const byNeed = priorityOrder({ queue: h.queue, blockerLabels: h.blockerLabels });
  if (view.layout === 'stacks') {
    const s = stacks(h.queue);
    return [...s.stacks.flatMap((rows) => mergeTree(rows, h.queue).rows.map((r) => r.pr)), ...s.alone.sort(byNeed)].filter((p) => (!view.repo || p.repo === view.repo) && inMilestone(p, view.milestone));
  }
  return h.queue.filter((p) => (view.filter === 'all' || bucket(p) === view.filter) && (!view.repo || p.repo === view.repo) && inMilestone(p, view.milestone)).sort(byNeed);
}

const EMPTY: Record<Filter, string> = {
  all: 'No open pull requests.',
  needs: 'You’re all caught up.',
  mine: 'You have no open pull requests.',
  waiting: 'Nothing is waiting on anyone else.',
  approved: 'Nothing approved and waiting to merge.',
  merged: 'Nothing merged recently.',
};

/** The PR's milestone, on every row that has one, so the queue shows which release each PR is in. */
function milestoneTag(p: PrSummary): string {
  if (!p.milestone) return '';
  const due = p.milestone.dueOn ? ` · due ${new Date(p.milestone.dueOn).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
  return `<span class="ms" title="Milestone: ${esc(p.milestone.title)}${due}">${I.milestone}${esc(p.milestone.title)}</span>`;
}

/** Who reviewed it, in a few words: whose changes are requested, or who approved. */
function reviewNote(p: PrSummary): string {
  const by = (state: string) => p.reviewers.filter((r) => r.state === state).map((r) => (r.login === host?.user ? 'you' : r.login));
  const changes = by('changes_requested');
  if (changes.length) return `<span class="rv warn">changes requested by ${esc(changes.join(', '))}</span>`;
  const approved = by('approved');
  if (approved.length) return `<span class="rv ok">${I.check}${esc(approved.join(', '))}</span>`;
  return '';
}

/**
 * Why a Your-turn row sits where it does: releases, PRs waiting on it, open P0/P1s, how long it's waited, and
 * (when the team uses Codex) whether Codex has reviewed it yet. Only on rows that are your turn.
 */
function whyNow(p: PrSummary, h: HostState): string {
  const pr = priority(p, { queue: h.queue, blockerLabels: h.blockerLabels });
  if (pr.section !== 'you' || !pr.signals) return '';
  const chips = reasons(p, pr.signals).map((r) => `<span class="why ${r.tone}" ${r.title ? `title="${esc(r.title)}"` : ''}>${esc(r.text)}</span>`);
  const teamUsesCodex = h.queue.some((q) => q.reviewers.some((r) => /codex/i.test(r.login)));
  if (teamUsesCodex && !p.mine && !isDependabot(p) && !p.reviewers.some((r) => /codex/i.test(r.login))) chips.push('<span class="why muted" title="Codex usually reviews first">No Codex review yet</span>');
  return chips.length ? `<span class="whys">${chips.slice(0, 3).join('')}</span>` : '';
}

/** One PR row. In the Stacks layout it's indented under the PR it's stacked on. */
function row(p: PrSummary, i: number, h: HostState, depth = 0, inStack = false, graph = '', chip = ''): string {
  const parent = view.layout === 'list' ? parentOf(p, h.queue) : null;
  const asked = p.reviewRequested && !p.myReview ? '<span class="chip ask">Review requested</span>' : '';
  const why = whyNow(p, h);
  const linear = p.linear ? (p.linear.url ? `<a class="lin" href="${esc(p.linear.url)}" title="Open in Linear">${esc(p.linear.key)}</a>` : `<span class="lin" title="Linear issue">${esc(p.linear.key)}</span>`) : '';
  return `<button class="qrow ${kbd && i === view.sel ? 'sel' : ''} ${depth ? 'nested' : ''}" data-open="${esc(prKey(p))}" data-vars="--depth:${depth}">
      ${graph}<span class="num">#${p.number}</span>
      <span class="t"><span class="tl"><b>${esc(p.title)}</b>${checksIcon(p)}</span><span class="sub">${multi(h) && !inStack ? `<span class="rp" title="${esc(p.repo)}">${esc(short(p.repo))}</span>` : ''}<span class="diffstat"><span class="a">+${p.additions}</span> <span class="d">−${p.deletions}</span></span><span class="${p.mine ? 'you' : ''}">${p.mine ? 'you' : esc(p.author)}</span>${parent ? `<span class="on">on #${parent.number}</span>` : ''}${linear}${milestoneTag(p)}${reviewNote(p)}</span>${why}</span>
      ${chip}${asked}<span class="st">${listStatus(p)}</span><span class="when" title="Updated ${ago(p.updatedAt)} ago">${ago(p.updatedAt)}</span></button>`;
}

/** One row's slice of a merge tree: the lines passing by or joining, and this PR's dot. */
function graphCell(t: TreeRow, lanes: number): string {
  const tone = prStatus(t.pr).tone;
  const parts = [
    ...t.through.map((l) => `<i class="gl full" data-vars="--l:${l}"></i>`),
    t.up ? `<i class="gl top" data-vars="--l:${t.lane}"></i>` : '',
    `<i class="gl bot" data-vars="--l:${t.lane}"></i>`,
    ...t.joins.map((l) => `<i class="gj" data-vars="--l:${l};--to:${t.lane}"></i>`),
    `<i class="gd ${tone} ${t.pr.isDraft ? 'draft' : ''}" data-vars="--l:${t.lane}"></i>`,
  ];
  return `<span class="graph" data-vars="--lanes:${lanes}" aria-hidden="true">${parts.join('')}</span>`;
}

/**
 * The Stacks layout: each stack as a merge tree, like a git graph. Newest PRs on top, each above the PR it's
 * stacked on, branches in their own columns, all flowing down into the base branch; the bottom PR merges next.
 * Then the PRs that stand alone.
 */
function stackedList(h: HostState): string {
  const { stacks: all, alone } = stacks(h.queue.filter((p) => (!view.repo || p.repo === view.repo) && inMilestone(p, view.milestone)));
  let i = 0;
  const tree = (rows: StackRow[]) => {
    const root = rows[0]!.pr;
    const t = mergeTree(rows, h.queue);
    const who = root.author === host?.user ? 'Your' : `${root.author}’s`;
    const body = t.rows.map((r) => row(r.pr, i++, h, 0, true, graphCell(r, t.lanes), r.pr === root && !root.isDraft ? '<span class="chip next" title="The bottom of the stack merges before the PRs above it">Merges first</span>' : '')).join('');
    const base = `<div class="trunk"><span class="graph" data-vars="--lanes:${t.lanes}" aria-hidden="true"><i class="gl top" data-vars="--l:0"></i><i class="gd base" data-vars="--l:0"></i></span><span class="mono">${esc(root.baseRef)}</span><span class="sub">merges bottom up</span></div>`;
    return `<div class="stack"><div class="stackh">${I.stack}<span>${esc(who)} stack · ${plural(rows.length, 'PR')}</span>${multi(h) ? `<span class="mono">${esc(root.repo)}</span>` : ''}</div><div class="list tree">${body}${base}</div></div>`;
  };
  const rest = visibleQueue(h).filter((p) => alone.includes(p));
  return `${all.map(tree).join('') || '<div class="empty">No stacked pull requests. A PR is stacked when its base is another PR’s branch.</div>'}
    ${rest.length ? `<span class="lbl stacklbl">Not stacked · ${rest.length}</span><div class="list">${rest.map((p) => row(p, i++, h)).join('')}</div>` : ''}`;
}

/** With several repos in view, narrow the list to one. */
function repoFilter(h: HostState): string {
  if (!multi(h)) return '';
  const repos = [...new Set(h.queue.map((p) => p.repo))].sort();
  if (view.repo && !repos.includes(view.repo)) view.repo = '';
  return `<select id="repofilter" class="repofilter" aria-label="Repository"><option value="">All repos · ${repos.length}</option>${repos.map((r) => `<option value="${esc(r)}" ${r === view.repo ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
}

/**
 * Narrow the queue to one milestone (a release), like GitHub's Milestones filter: soonest due first. Only when
 * some PR in the queue has a milestone.
 */
function milestoneFilter(h: HostState): string {
  const all = milestones(h.queue);
  if (!all.length) return '';
  if (view.milestone && !all.some((m) => m.title === view.milestone)) view.milestone = null;
  const none = h.queue.filter((p) => !p.milestone).length;
  const when = (d: string | null) => (d ? ` · due ${new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '');
  const opt = (value: string, label: string, on: boolean) => `<option value="${esc(value)}" ${on ? 'selected' : ''}>${esc(label)}</option>`;
  return `<select id="msfilter" class="repofilter" aria-label="Milestone"><option value="*" ${view.milestone === null ? 'selected' : ''}>All milestones</option>${all.map((m) => opt(`=${m.title}`, `${m.title}${when(m.dueOn)} · ${m.count}`, view.milestone === m.title)).join('')}${none ? opt(`=${NO_MILESTONE}`, `No milestone · ${none}`, view.milestone === NO_MILESTONE) : ''}</select>`;
}

/** "All", split by who acts next: your turn first, then what waits on someone else (dimmed), then merged. */
function sections(rows: PrSummary[], h: HostState): string {
  const parts: { key: 'you' | 'others' | 'merged'; label: string }[] = [
    { key: 'you', label: 'Your turn' }, { key: 'others', label: 'Waiting on others' }, { key: 'merged', label: 'Merged' },
  ];
  let i = 0;
  return parts.map(({ key, label }) => {
    const prs = rows.filter((p) => priority(p).section === key);
    if (!prs.length) return key === 'you' ? `<span class="lbl sect">${label}</span><div class="list"><div class="empty">${I.check}You’re all caught up.</div></div>` : '';
    return `<span class="lbl sect">${label} · ${prs.length}</span><div class="list ${key === 'you' ? '' : 'later'}">${prs.map((p) => row(p, i++, h)).join('')}</div>`;
  }).join('');
}

function queue(h: HostState): string {
  const counts: Record<Filter, number> = { all: h.queue.length, needs: 0, mine: 0, waiting: 0, approved: 0, merged: 0 };
  h.queue.forEach((p) => counts[bucket(p)]++);
  const rows = visibleQueue(h);
  if (view.sel >= rows.length) view.sel = Math.max(0, rows.length - 1);
  const f = (k: Filter, label: string) => `<button data-filter="${k}" aria-pressed="${view.filter === k}" ${!counts[k] && view.filter !== k ? 'disabled' : ''}>${label} <span class="n">${counts[k]}</span></button>`;
  // Your PRs only shows when you have some (a solo reviewer of agent PRs has none).
  const mine = counts.mine || view.filter === 'mine' ? f('mine', 'Your PRs') : '';
  const stacked = view.layout === 'stacks';
  const empty = h.loading ? '<div class="empty"><span class="spin"></span>Loading pull requests</div>' : `<div class="empty">${view.filter === 'needs' ? I.check : ''}${EMPTY[view.filter]}</div>`;
  const layout = `<div class="seg layout" role="group" aria-label="Layout"><button data-layout="list" aria-pressed="${!stacked}" title="List by what each PR needs">List</button><button data-layout="stacks" aria-pressed="${stacked}" title="Stacked PRs as trees, in merge order">${I.stack}Stacks</button></div>`;
  return `<div class="crumb"><span class="home cur">${I.inbox}Review queue</span>
      <button class="reposw ${h.scope.startsWith('Everything') ? 'all' : ''}" data-do="switchRepo" title="Choose what to review">${h.scope.startsWith('Everything') ? I.globe : ''}${esc(h.scope)}${I.down}</button>${h.sample ? '<span class="chip">Sample data</span>' : ''}
      <div class="end">${bulkButton(h)}${updated(h)}<button class="btn icon" data-do="refresh" aria-label="Refresh" title="Refresh (r)">${I.rerun}</button><button class="btn icon" data-do="keys" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button></div></div>
    ${h.notice ? `<div class="note" role="status">${I.check}<span>${esc(h.notice)}</span><button class="btn sm" data-do="dismissNotice">Dismiss</button></div>` : ''}
    <div class="pad">
      <div class="toolbar">${stacked ? '' : `<div class="seg filters" role="group" aria-label="Filter">${f('all', 'All')}${f('needs', 'Needs you')}${mine}${f('waiting', 'Waiting on others')}${f('approved', 'Approved')}${f('merged', 'Merged')}</div>`}${repoFilter(h)}${milestoneFilter(h)}${layout}</div>
      ${stacked ? (h.loading && !h.queue.length ? empty : stackedList(h)) : view.filter === 'all' && rows.length ? sections(rows, h) : `<div class="list">${rows.map((p, i) => row(p, i, h)).join('') || empty}</div>`}
    </div>`;
}

/** One click for the Dependabot updates that are safe to merge without opening: no conflicts, checks passed. */
function bulkButton(h: HostState): string {
  if (h.busy === 'bulk' && h.bulk) return `<button class="btn pri" disabled><span class="spin"></span>Merging ${h.bulk.done + 1} of ${h.bulk.total}</button>`;
  const ready = bulkMergeable(h.queue);
  if (!ready.length) return '';
  const held = h.queue.filter((p) => isDependabot(p) && p.state === 'open' && !ready.includes(p)).length;
  const tip = `Approves and merges ${ready.map((p) => (multi(h) ? `${short(p.repo)}#${p.number}` : `#${p.number}`)).join(', ')}, one at a time.${held ? ` ${plural(held, 'other Dependabot update')} ${held === 1 ? 'has' : 'have'} conflicts or failing checks; open ${held === 1 ? 'it' : 'them'} to review.` : ''}`;
  return `<button class="btn pri" data-do="mergeDependabot" title="${esc(tip)}" ${h.busy ? 'disabled' : ''}>${I.merge}<span class="long">Merge ${plural(ready.length, 'Dependabot update')}</span><span class="short">Merge ${plural(ready.length, 'update')}</span></button>`;
}

/* ---------- PR ---------- */
function crumb(pr: PrDetail, h: HostState): string {
  // Two rows, like GitHub: the title gets its own line (wrapping to two), the details and the decision share the next.
  const meta = `<span class="who">${esc(pr.author)}</span> wants to merge <span class="br head" title="${esc(pr.headRef)}">${esc(pr.headRef)}</span> into <span class="br">${esc(pr.baseRef)}</span>${parentLink(pr)}`;
  return `<div class="crumb prh"><button class="back" data-do="back" aria-label="Back to the review queue" title="Back to the review queue (Esc)">${I.back}</button>
    <div class="hd"><div class="r1">${host && multi(host) ? `<span class="rpo" title="Repository">${esc(pr.repo)}</span>` : ''}<button class="ttl" data-ext="${esc(pr.url)}" title="Open on GitHub"><b>${esc(pr.title)}</b> <span class="num">#${pr.number}</span>${I.ext}</button><span class="diffstat" title="Lines added and removed">+${pr.additions} <span class="d">−${pr.deletions}</span></span></div>
      <div class="r2"><span class="meta">${meta}</span><div class="end">${pr.state === 'merged' ? `<span role="status">${statusPill(pr)}</span>` : `${summary(pr, h)}${decision(pr, h)}`}</div></div></div></div>`;
}

/** "(#101)" after a stacked PR's base branch, opening the PR it's stacked on. */
function parentLink(pr: PrDetail): string {
  const parent = parentOf(pr, host?.queue ?? []);
  return parent ? `<button class="link" data-open="${esc(prKey(parent))}" title=""Stacked on #${parent.number}: ${esc(parent.title)}">#${parent.number}</button>` : '';
}

const TONE_ICON: Record<Tone, string> = { ok: I.check, bad: I.x, warn: I.alert, run: '<span class="spin sm"></span>', muted: I.minus };

/**
 * The one line beside the button: the most urgent thing to know, or that it's ready. It's a disclosure,
 * styled as text, that opens the merge checklist.
 */
function summary(pr: PrDetail, h: HostState): string {
  const s = mergeSummary(pr, h.queue, h.user);
  const open = view.menu === 'checklist';
  // When nothing needs attention the button already says so; the line shrinks to a quiet check.
  const quiet = s.tone === 'ok';
  return `<div class="dz"><button class="sumline ${s.tone} ${quiet ? 'quiet' : ''}" data-menu="checklist" aria-expanded="${open}" aria-haspopup="dialog" aria-label="${esc(s.text)}: merge checklist" title="${quiet ? `${esc(s.text)}. Open the merge checklist.` : 'Merge checklist'}">${TONE_ICON[s.tone]}${quiet ? '' : `<span class="sumtext">${esc(s.text)}${s.more ? ` <span class="more">+${s.more}</span>` : ''}</span>`}${I.down}</button>${open ? checklist(pr, h) : ''}</div>`;
}

/** GitHub's merge box, on demand: every condition, each with its fix. */
/** The header's status popover: the same status card as Overview's, so there's one design in two places. */
function checklist(pr: PrDetail, h: HostState): string {
  return `<div class="pop cardpop" role="dialog" aria-label="Merge status">${statusCardView(pr, h, true)}</div>`;
}

/**
 * The status card: what this PR needs and whose turn it is, Checks, Findings, Comments and Approvals as bars of
 * one piece per item (click one for its details), and what blocks a merge with its fix. One line when it's ready.
 */
function statusCardView(pr: PrDetail, h: HostState, inPop = false): string {
  const c = statusCard(pr, h.queue, h.user);
  const compat = isDependabot(pr) && pr.compatibility != null ? (() => {
    const tone = pr.compatibility >= 80 ? 'ok' : pr.compatibility >= 50 ? 'warn' : 'bad';
    return `<span class="why ${tone}" title="Dependabot's compatibility score: in ${pr.compatibility}% of other repos, this update passed CI">Compatibility ${pr.compatibility}%</span>`;
  })() : '';
  if (c.ready && !view.cardOpen && !inPop) {
    return `<div class="scard compact ok">${TONE_ICON.ok}<b>${esc(c.title)}</b><span class="sub">${esc(c.sub)}</span>${compat}<button class="link" data-do="cardOpen">Details${I.down}</button></div>`;
  }
  const parts = c.parts.map((p) => {
    const segs = p.segments.length ? p.segments.map((t) => `<i class="${t}"></i>`).join('') : '<i class="none"></i>';
    return `<button class="sc-p ${p.tone} ${view.part === p.key ? 'on' : ''}" data-part="${p.key}" aria-expanded="${view.part === p.key}">
      <span class="sc-l"><b>${p.label}</b><span class="sc-s">${esc(p.summary)}</span>${p.locked ? `<span class="lock" title="Gates merging">${I.lock}</span>` : ''}</span><span class="bar">${segs}</span></button>`;
  }).join('');
  const blockers = c.blockers.map((b) => `<div class="sc-b ${b.tone}">${TONE_ICON[b.tone]}<span>${esc(b.key === 'conflicts' ? conflictText(pr) : b.key === 'stack' && b.pr ? `Stacked on #${parseKey(b.pr)?.number}: it merges into ${pr.baseRef} until #${parseKey(b.pr)?.number} is in.` : b.text)}</span>${blockerAction(pr, h, b.key, b.pr)}</div>`).join('');
  return `<div class="scard ${c.tone}"><div class="sc-h"><span class="sc-i ${c.tone}">${TONE_ICON[c.tone]}</span><span class="sc-t"><b>${esc(c.title)}</b>${c.sub ? `<span class="sub">${esc(c.sub)}</span>` : ''}</span>${compat}${c.ready && !inPop ? `<button class="link" data-do="cardOpen">Less</button>` : ''}</div>
    <div class="sc-parts">${parts}</div>${view.part ? `<div class="sc-d">${partDetail(view.part, pr, h)}</div>` : ''}${blockers}</div>`;
}

/** Each part's details, under the card: the items behind the bar, with what you can do about them. */
function partDetail(k: PartKey, pr: PrDetail, h: HostState): string {
  if (k === 'checks') {
    const groups: [string, CheckRun[]][] = [
      ['failing', pr.checkRuns.filter(isFailing)], ['running', pr.checkRuns.filter((r) => r.status !== 'completed')],
      ['skipped', pr.checkRuns.filter(isSkipped)], ['successful', pr.checkRuns.filter((r) => r.status === 'completed' && !isFailing(r) && !isSkipped(r))],
    ];
    const row = (r: CheckRun) => {
      const fail = isFailing(r);
      const when = fail ? `Failing after ${duration(r.seconds)}` : r.status !== 'completed' ? 'Running' : isSkipped(r) ? 'Skipped' : r.seconds != null ? `Successful in ${duration(r.seconds)}` : 'Successful';
      const icon = fail ? `<span class="g bad">${I.x}</span>` : r.status !== 'completed' ? '<span class="g run"><span class="spin sm"></span></span>' : isSkipped(r) ? `<span class="g muted">${I.minus}</span>` : `<span class="g ok">${I.check}</span>`;
      return `<li>${icon}<span class="nm">${esc(r.name)}</span><span class="tool">${esc(r.app)}</span><span class="sub">${esc(when.replace(/ after $| in $/, ''))}</span>${r.required ? '<span class="chip">Required</span>' : ''}
        <span class="end">${fail ? `<button class="btn sm fix" data-fix="${esc(r.name)}">${I.spark}Fix with agent</button>` : ''}${r.url ? `<button class="link" data-ext="${esc(r.url)}">${fail ? 'Log' : 'Details'}${I.ext}</button>` : ''}</span></li>`;
    };
    return groups.filter(([, rs]) => rs.length).map(([name, rs]) => `<span class="lbl">${plural(rs.length, `${name} check`)}</span><ul>${rs.map(row).join('')}</ul>`).join('') || '<p class="none">This repo runs no checks on pull requests.</p>';
  }
  const all = threads(pr);
  const gist = (t: Thread) => esc((t.comments[0]?.text ?? '').replace(/\s+/g, ' ').replace(/^\**P[0-3]\**\s*/, '').slice(0, 110));
  const at = (t: Thread) => `${base(t.path)}${t.line ? `:${t.line}` : ''}`;
  if (k === 'findings') {
    const open = all.filter((t) => t.severity != null && !t.resolved).sort((a, b) => a.severity! - b.severity!);
    const done = all.filter((t) => t.severity != null && t.resolved).length;
    return (open.length ? `<ul>${open.map((t) => `<li class="link-row" data-goto="${esc(t.id)}">${sevChip(t.severity)}<span class="gist">${gist(t)}</span><span class="mono sub">${esc(at(t))}</span></li>`).join('')}</ul>` : '<p class="none">No open findings.</p>')
      + (done ? `<p class="sub">${plural(done, 'finding')} resolved.</p>` : '');
  }
  if (k === 'comments') {
    const open = all.filter((t) => t.severity == null && !t.resolved);
    return open.length
      ? `<ul>${open.map((t) => `<li class="link-row" data-goto="${esc(t.id)}"><b>${esc(who(t.comments[0]?.author ?? ''))}</b><span class="gist">${gist(t)}</span><span class="mono sub">${esc(at(t))}</span></li>`).join('')}</ul><button class="link" data-conv="unresolved">Show unresolved in the conversation</button>`
      : '<p class="none">No unresolved comments.</p>';
  }
  const why = pr.reviewDecision === null ? 'This repo doesn’t require approvals; your approval is the review.'
    : pr.reviewDecision === 'approved' ? 'GitHub has the approvals it needs.'
    : pr.reviewDecision === 'changes_requested' ? 'Changes were requested; it needs a new approval after they’re made.'
    : 'GitHub needs an approving review before this can merge.';
  return `${reviewersList(pr)}<p class="sub">${why}</p>`;
}

/** A blocker's one fix: resolve the conflict (whoever should), bring the base in, or open the PR below. */
function blockerAction(pr: PrDetail, h: HostState, key: string, prKeyBelow?: string): string {
  if (key === 'conflicts') return conflictAction(pr);
  if (key === 'draft') return `<button class="btn sm" data-do="readyForReview" ${h.busy ? 'disabled' : ''}>${h.busy === 'draft' ? '<span class="spin sm"></span>' : ''}Ready for review</button>`;
  if (key === 'base') return `<button class="btn sm" data-do="updateBranch" ${h.busy ? 'disabled' : ''}>${h.busy === 'update' ? '<span class="spin sm"></span>' : ''}Update branch</button>`;
  if (key === 'stack' && prKeyBelow) return `<button class="btn sm" data-open="${esc(prKeyBelow)}">Open #${parseKey(prKeyBelow)?.number ?? ''}</button>`;
  return '';
}

const VERB: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
const METHOD_NOTE: Record<MergeMethod, string> = {
  squash: 'Combine all commits into one on the base branch.',
  merge: 'Keep every commit, joined by a merge commit.',
  rebase: 'Replay each commit onto the base branch.',
};

/** The one button that moves the PR forward: Approve, then GitHub's "Squash and merge ▾". */
/**
 * GitHub's "Review changes": one click approves; ▾ opens the review with a summary and Comment, Approve or
 * Request changes. With comments held back, the button sends them: "Submit review · 3".
 */
function reviewButton(pr: PrDetail, h: HostState, primary: boolean): string {
  // Comments held back here, plus any in a review you started on github.com: they all go with the review.
  const held = h.drafts.filter((d) => d.from === 'you').length + (pr.pendingReview?.comments ?? 0);
  const open = view.menu === 'review';
  const cls = `btn ${primary ? 'pri' : ''}`;
  const main = held || !primary
    ? `<button class="${cls} main" data-menu="review" ${h.busy ? 'disabled' : ''}>${h.busy === 'review' ? '<span class="spin"></span>' : I.com}${held ? `Submit review · ${held}` : 'Review'}</button>`
    : `<button class="${cls} main" data-do="approve" ${h.busy ? 'disabled' : ''}>${h.busy === 'approve' ? '<span class="spin"></span>' : I.check}Approve</button>`;
  return `<div class="splitbtn">${main}<button class="${cls} caret" data-menu="review" aria-haspopup="dialog" aria-expanded="${open}" aria-label="Finish your review: comment, approve or request changes" ${h.busy ? 'disabled' : ''}>${I.down}</button>${open ? reviewPanel(pr, h) : ''}</div>`;
}

const EVENTS: { event: ReviewEvent; label: string; note: string }[] = [
  { event: 'COMMENT', label: 'Comment', note: 'Feedback without approving or blocking.' },
  { event: 'APPROVE', label: 'Approve', note: 'Good to merge.' },
  { event: 'REQUEST_CHANGES', label: 'Request changes', note: 'Must be addressed before it merges.' },
];

/** The verdict the review panel has picked: the one you chose, or Comment, as on GitHub. */
function verdict(pr: PrDetail): ReviewEvent {
  if (pr.mine) return 'COMMENT';
  return view.reviewEvent ?? 'COMMENT';
}

function reviewPanel(pr: PrDetail, h: HostState): string {
  const own = pr.mine;
  const event = verdict(pr);
  const held = h.drafts.filter((d) => d.from === 'you' && !d.sent).length;
  const agent = h.drafts.filter((d) => d.from === 'agent').length;
  const f = openFindings(pr);
  const warn = event === 'APPROVE' && (f.p0 || f.p1) ? `<p class="rwarn">${I.alert}${stillOpen(f)}.</p>` : '';
  const radios = EVENTS.map((e) => {
    const off = own && e.event !== 'COMMENT';
    return `<label class="rv-opt ${off ? 'off' : ''}"><input type="radio" name="revent" value="${e.event}" ${e.event === event ? 'checked' : ''} ${off ? 'disabled' : ''}><span><b>${e.label}</b><span class="sub">${off ? 'Not on your own pull request.' : e.note}</span></span></label>`;
  }).join('');
  return `<div class="pop review" role="dialog" aria-label="Finish your review"><span class="lbl">Finish your review</span>
    <textarea id="rbody" rows="3" placeholder="${event === 'REQUEST_CHANGES' ? 'Say what needs to change (required)' : 'Leave a summary (optional)'}" aria-label="Review summary"></textarea>
    <div class="rv-opts">${radios}</div>
    ${pr.pendingReview?.comments ? `<p class="rnote">You have a review in progress on GitHub with ${plural(pr.pendingReview.comments, 'comment')}; ${pr.pendingReview.comments === 1 ? 'it goes' : 'they go'} with this one.</p>` : ''}
    ${held || agent ? `<p class="rnote">${held ? `${plural(held, 'comment')} will be sent with it.` : ''}${agent ? ` ${plural(agent, 'suggestion')} from your agent stay${agent === 1 ? 's' : ''} as drafts until you keep ${agent === 1 ? 'it' : 'them'}.` : ''}</p>` : ''}
    ${warn}<div class="ract"><button class="btn pri" data-do="submitReview" ${h.busy ? 'disabled' : ''}>Submit review</button></div></div>`;
}

function decision(pr: PrDetail, h: HostState): string {
  // Not yet approved by you (or a re-review): the review is the decision. You can't approve your own PR.
  if (!pr.mine && (pr.myReview !== 'approved' || isReReview(pr))) return reviewButton(pr, h, true);
  // After approving, or on your own PR: Merge leads; comments you hold back still get a way out.
  const extra = h.drafts.some((d) => d.from === 'you') ? reviewButton(pr, h, false) : '';
  return extra + mergeButton(pr, h);
}

function mergeButton(pr: PrDetail, h: HostState): string {
  const blocker = mergeBlocker(pr, h.queue);
  const method = view.method && pr.mergeMethods.includes(view.method) ? view.method : pr.mergeMethods[0]!;
  // With a check failing, Merge stays available but stops being the primary action and says "anyway".
  const warning = !blocker && mergeWarning(pr);
  const cls = `btn ${warning ? '' : 'pri'}`;
  const off = h.busy || blocker ? 'disabled' : '';
  const tip = blocker || (warning ? `${warning}. You'll be asked to confirm.` : '');
  const main = `<button class="${cls} main" data-do="merge" data-method="${method}" ${off} ${tip ? `title="${esc(tip)}"` : ''}>${h.busy === 'merge' ? '<span class="spin"></span>' : I.merge}${VERB[method]}${warning ? ' anyway' : ''}</button>`;
  if (pr.mergeMethods.length < 2) return main;
  const open = view.menu === 'methods';
  const menu = open ? `<div class="pop menu" role="menu" aria-label="Merge method">${pr.mergeMethods.map((m) => `<button role="menuitemradio" aria-checked="${m === method}" data-method-pick="${m}"><span class="mk">${m === method ? I.check : ''}</span><span><b>${VERB[m]}</b><span class="sub">${METHOD_NOTE[m]}</span></span></button>`).join('')}</div>` : '';
  return `<div class="splitbtn">${main}<button class="${cls} caret" data-menu="methods" aria-haspopup="menu" aria-expanded="${open}" aria-label="Choose how to merge" ${h.busy ? 'disabled' : ''}>${I.down}</button>${menu}</div>`;
}

/** Who resolves a conflict depends on whose PR it is: you or your agent, Dependabot itself, or the teammate who wrote it. */
function conflictText(pr: PrDetail): string {
  if (isDependabot(pr)) return `Conflicts with ${pr.baseRef}. Dependabot can rebuild the branch.`;
  if (pr.mine || isAgent(pr.author)) return `Conflicts with ${pr.baseRef}. Resolve them before merging.`;
  return `Conflicts with ${pr.baseRef}. ${pr.author} resolves them; you can still review and approve the code now.`;
}

function conflictAction(pr: PrDetail): string {
  if (isDependabot(pr)) return '<button class="btn sm" data-do="dependabotRebase" title="Posts “@dependabot rebase”">Ask Dependabot to rebase</button>';
  if (pr.mine || isAgent(pr.author)) return `<button class="btn sm fix" data-do="fixConflicts">${I.spark}Fix with agent</button>`;
  return `<button class="btn sm" data-do="askResolve">Ask ${esc(pr.author)} to resolve</button>`;
}

/** Coding agents and bots, whose conflicts your own agent can fix, as opposed to a teammate's branch. */
const isAgent = (login: string) => /\[bot\]$/i.test(login) || ['claude', 'codex', 'copilot', 'devin', 'cursor', 'sweep'].includes(login.toLowerCase());

/**
 * Dependabot PRs can be closed, or their update ignored, with a comment Dependabot reads. It lives on the
 * Checks page, where a broken update shows up, not beside Merge where it would be one slip away.
 */
function closeButton(pr: PrDetail): string {
  return isDependabot(pr) && pr.state === 'open' ? `<button class="btn" data-do="closeDependabot" title="Close this PR, or tell Dependabot to skip this update">Close or ignore…</button>` : '';
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

/** The PR's pages, as GitHub's tabs: Overview (its Conversation tab), Checks, Files changed. */
function sidebar(pr: PrDetail): string {
  const c = checksState(pr);
  const n = conversationCounts(pr.conversation);
  const seen = pr.files.filter((f) => f.viewed === 'viewed').length;
  const filesDone = pr.state === 'merged' || pr.myReview === 'approved' || (pr.files.length > 0 && seen === pr.files.length);
  const glyph = { done: I.check, fail: I.x, run: '', now: '', info: I.doc } as const;
  const step = (k: Step, label: string, cls: keyof typeof glyph, sub: string, key: number) =>
    `<li class="step ${cls}"><button class="stepbtn" data-step="${k}" aria-current="${view.step === k ? 'page' : 'false'}" title="${label} (${key})"><span class="sd" aria-hidden="true">${glyph[cls]}</span><span class="sl"><span>${label}</span><span class="sub ${k === 'overview' && n.fresh ? 'fresh' : ''}">${sub}</span></span></button></li>`;
  const overviewSub = n.fresh ? `${plural(n.fresh, 'new comment')}` : n.comments ? plural(n.comments, 'comment') : 'No comments';
  const filesSub = pr.myReview === 'approved' ? `Approved · ${seen} of ${pr.files.length} viewed` : `${seen} of ${plural(pr.files.length, 'file')} viewed`;
  return `<aside class="side" aria-label="Pull request pages"><ol class="steps">
    ${step('overview', 'Overview', 'info', overviewSub, 1)}${step('checks', 'Checks', c.cls, c.sub, 2)}${step('files', 'Files changed', filesDone ? 'done' : 'now', filesSub, 3)}</ol>
    ${details(pr)}${stackNav(pr)}
    <div class="railfoot">${updated(host!)}<button class="link keyslink" data-do="keys">Keyboard shortcuts <kbd>?</kbd></button></div></aside>`;
}

function checkRow(r: CheckRun): string {
  const fail = isFail(r);
  const g = fail ? `<span class="g bad">${I.x}</span>` : r.status !== 'completed' ? '<span class="g run"><span class="spin sm"></span></span>' : `<span class="g ok">${I.check}</span>`;
  const why = fail && (r.failedStep || r.excerpt) ? `<div class="cgb">${r.failedStep ? `<span class="fstep">Failed at <b>${esc(r.failedStep)}</b></span>` : ''}${r.excerpt ? `<pre class="log">${r.excerpt.map(esc).join('\n')}</pre>` : ''}</div>` : '';
  if (!fail && r.status === 'completed') {
    // A passing check is one compact line; Details shows on hover.
    return `<div class="crow">${g}<span class="nm">${esc(r.name)}</span><span class="tool">${esc(r.app)}</span>${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}${r.url ? `<button class="link det" data-ext="${esc(r.url)}">Details${I.ext}</button>` : ''}</div>`;
  }
  return `<div class="cg ${fail ? 'bad' : ''}"><div class="cgh">${g}<span class="nm">${esc(r.name)}</span><span class="tool">${esc(r.app)}</span>
    <span class="res">${r.summary ? `<span class="sum">${esc(r.summary)}</span>` : ''}${fail ? `<button class="btn sm fix" data-fix="${esc(r.name)}" title="Send the failure to your AI agent to diagnose and fix">${I.spark}Fix with agent</button>` : ''}${r.url ? `<button class="btn sm" data-ext="${esc(r.url)}">${fail ? 'Open log' : 'Details'}${I.ext}</button>` : ''}</span></div>${why}</div>`;
}

/** The whole stack this PR is in, bottom first, so you can move along it. Nothing when it stands alone. */
function stackNav(pr: PrDetail): string {
  const rows = stackOf(pr, host?.queue ?? []);
  if (rows.length < 2) return '';
  const items = rows.map((r) => {
    const st = prStatus(r.pr);
    const here = prKey(r.pr) === prKey(pr);
    return `<li data-vars="--depth:${r.depth}"><button class="snode ${here ? 'here' : ''}" ${here ? 'aria-current="true"' : `data-open="${esc(prKey(r.pr))}"`} title="#${r.pr.number} ${esc(r.pr.title)} · ${esc(st.label)}"><span class="sdot ${st.tone}"></span><span class="num">#${r.pr.number}</span><span class="stt">${esc(r.pr.title)}</span></button></li>`;
  }).join('');
  return `<div class="stacknav" title="Stacked PRs merge bottom first"><span class="lbl">${I.stack}Stack</span><span class="sbase mono">${esc(rows[0]!.pr.baseRef)}</span><ol>${items}</ol></div>`;
}

/** Who's reviewing and what the PR is attached to, like GitHub's sidebar: only what's set, reviewers always. */
function details(pr: PrDetail): string {
  const me = host?.user ?? '';
  const state: Record<string, [string, string, string]> = {
    approved: ['ok', I.check, 'Approved'], changes_requested: ['bad', I.x, 'Requested changes'], commented: ['muted', I.com, 'Commented'], requested: ['run', I.clock, 'Asked to review'],
  };
  // GitHub's own wording and place: under the reviewers.
  const toDraft = pr.state === 'open' && !pr.isDraft ? `<p class="sub todraft">Still in progress? <button class="link" data-do="toDraft" ${host?.busy ? 'disabled' : ''}>Convert to draft</button></p>` : '';
  return `<div class="details"><div class="dg"><span class="lbl">Reviewers</span>${reviewersList(pr)}${toDraft}</div>${detailsRest(pr)}</div>`;
}

function reviewersList(pr: PrDetail): string {
  const me = host?.user ?? '';
  const state: Record<string, [string, string, string]> = {
    approved: ['ok', I.check, 'Approved'], changes_requested: ['bad', I.x, 'Requested changes'], commented: ['muted', I.com, 'Commented'], requested: ['run', I.clock, 'Asked to review'],
  };
  const reviewers = pr.reviewers.length
    ? pr.reviewers.map((r) => { const [tone, icon, what] = state[r.state]!; return `<li class="${tone}" title="${esc(what)}">${icon}<span>${r.login === me ? 'you' : esc(who(r.login))}</span><span class="sub">${what}</span></li>`; }).join('')
    : '<li class="none">No reviewers</li>';
  return `<ul class="revs">${reviewers}</ul>`;
}

function detailsRest(pr: PrDetail): string {
  const ms = pr.milestone ? `<div class="dg"><span class="lbl">Milestone</span><span>${esc(pr.milestone.title)}${pr.milestone.dueOn ? `<span class="sub"> · due ${new Date(pr.milestone.dueOn).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>` : ''}</span></div>` : '';
  const labels = pr.labels.length ? `<div class="dg"><span class="lbl">Labels</span><span class="labels">${pr.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join('')}</span></div>` : '';
  const linear = pr.linear ? `<div class="dg"><span class="lbl">Linear</span>${pr.linear.url ? `<a class="lin" href="${esc(pr.linear.url)}">${esc(pr.linear.key)}</a>` : `<span class="mono">${esc(pr.linear.key)}</span>`}</div>` : '';
  return `${labels}${ms}${linear}`;
}

function stepChecks(pr: PrDetail): string {
  const byName = (a: CheckRun, b: CheckRun) => a.name.localeCompare(b.name);
  const failing = pr.checkRuns.filter(isFail).sort(byName);
  const running = pr.checkRuns.filter((r) => r.status !== 'completed').sort(byName);
  const passed = pr.checkRuns.filter((r) => !isFail(r) && r.status === 'completed').sort(byName);
  const line = `<div class="chkbar"><span class="mono">${esc(pr.headSha.slice(0, 7))}</span><span class="mono">${esc(pr.headRef)} → ${esc(pr.baseRef)}</span>${closeButton(pr) ? `<span class="end">${closeButton(pr)}</span>` : ''}</div>`;
  if (!pr.checkRuns.length) return `${line}<div class="pad"><div class="empty">This repo runs no checks on pull requests.</div></div>`;
  const fold = passed.length ? `<div class="passed"><button class="link" data-do="togglePassed" aria-expanded="${view.showPassed}"><span class="g ok">${I.check}</span>${failing.length || running.length ? plural(passed.length, 'check') + ' passed' : `All ${plural(passed.length, 'check')} passed`}${I.down}</button>${view.showPassed ? `<div class="crows">${passed.map(checkRow).join('')}</div>` : ''}</div>` : '';
  return `${line}<div class="pad">${failing.map(checkRow).join('')}${running.map(checkRow).join('')}${fold}</div>`;
}

function stepFiles(pr: PrDetail): string {
  const files = pr.files;
  if (!view.file || !files.some((f) => f.path === view.file)) view.file = (files.find((f) => f.viewed !== 'viewed') ?? files[0])?.path ?? null;
  const file = files.find((f) => f.path === view.file);
  const seen = files.filter((f) => f.viewed === 'viewed').length;
  const since = pr.sinceLastLook;
  const changedSince = new Set(since?.files.map((f) => f.path) ?? []);

  const q = reviewQueue(pr, host!.drafts, host!.user);
  const marks = fileMarks(q);
  const near = view.near && q.length > 0;
  const cur = q.find((x) => x.id === view.finding) ?? null;

  const flist = files.map((f) => {
    const isNew = changedSince.has(f.path) || f.viewed === 'changed';
    const m = marks.get(f.path);
    const first = m && q.find((x) => x.path === f.path);
    const badge = m && first ? `<button class="qn ${sevTone(m.severity)}" data-q="${esc(first.id)}" title="${plural(m.count, 'comment')} to go through. Show ${m.count > 1 ? 'the first' : 'it'}" aria-label="${plural(m.count, 'comment')} to go through in ${esc(base(f.path))}">${m.count}</button>` : '';
    const here = near ? cur?.path === f.path : view.file === f.path;
    return `<div class="frow" aria-current="${here}">
      <input type="checkbox" class="vbox" data-viewed="${esc(f.path)}" ${f.viewed === 'viewed' ? 'checked' : ''} aria-label="Viewed ${esc(f.path)}">
      <button class="fn" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="bn">${esc(base(f.path))}</span><span class="dir">${esc(dir(f.path).replace(/\/$/, ''))}</span></button>
      ${isNew ? '<span class="newdot" title="Changed since you looked"></span>' : ''}${badge}<span class="diffstat"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span></div>`;
  }).join('');

  let lines = file?.lines ?? null;
  const fileSince = since?.files.find((f) => f.path === file?.path);
  if (view.onlyNew && fileSince) lines = fileSince.lines;
  const banner = since && pr.state !== 'merged' ? `<div class="newbar">${I.rerun}<b>${plural(since.commits, 'new commit')} since your ${since.kind === 'review' ? 'review' : 'last look'}</b><span class="chip">${esc(since.fromSha.slice(0, 7))}…${esc(since.toSha.slice(0, 7))}</span><span>${since.files.map((f) => esc(base(f.path))).join(', ')}</span>
    ${fileSince ? `<div class="seg"><button data-onlynew="0" aria-pressed="${!view.onlyNew}">Whole change</button><button data-onlynew="1" aria-pressed="${view.onlyNew}">${since.kind === 'review' ? 'Since your review' : 'Since you looked'}</button></div>` : since.files[0] ? `<button class="btn sm" data-file="${esc(since.files[0].path)}" data-onlynew="1">Show it${I.chev}</button>` : ''}</div>` : '';

  const whole = file ? `<div class="dh"><span class="mono">${esc(file.path)}</span><label class="vt"><input type="checkbox" data-viewed="${esc(file.path)}" ${file.viewed === 'viewed' ? 'checked' : ''}> Viewed</label></div>
        <div class="code" data-path="${esc(file.path)}">${lines ? renderDiff(file!.path, lines, pr) : '<div class="empty">GitHub sends no diff for this file. It’s binary or too large to show.</div>'}</div>` : '<div class="empty">No files changed.</div>';

  return `${banner}${queueBar(q, cur, near)}
    <div class="split"><nav class="files" aria-label="Changed files">${pr.state === 'open' ? `<button class="btn sm fix agentrev" data-do="reviewWithAgent" title="Your agent reviews this PR adversarially; its findings come back as drafts">${I.spark}Review with agent</button>` : ''}<div class="fh"><span class="lbl">Files</span><span class="cnt">${seen}/${files.length} viewed</span></div>${flist}</nav>
      <div class="dwrap"><section class="diffpane" aria-label="Diff" data-shows="${near ? '' : esc(file?.path ?? '')}">${near ? nearDiff(q, pr) : whole}</section><div class="rail" aria-hidden="true"></div></div></div>`;
}

/** Severity as a color class for the file list's counts and the scrollbar's marks: only P0 and P1 get one. */
const sevTone = (n: number | null) => (n === 0 ? 's0' : n === 1 ? 's1' : '');

/**
 * Where you are in the comments to go through, with Previous and Next, and whether the diff shows whole files
 * or only the code near those comments. Hidden when nothing is left to go through.
 */
function queueBar(q: QueueItem[], cur: QueueItem | null, near: boolean): string {
  if (!q.length) return '';
  // On the only one left, there's nowhere to step to.
  const only = !!cur && q.length === 1;
  const where = cur ? `${sevChip(cur.severity)}${cur.kind === 'draft' ? `<span class="chip agent">${I.spark}From your agent</span>` : ''}<button class="link mono" data-q="${esc(cur.id)}" title="Show it">${esc(base(cur.path))}${cur.line ? `:${cur.line}` : ''}</button>` : '';
  return `<div class="qbar"><b>${cur ? `Comment ${q.indexOf(cur) + 1} of ${q.length}` : `${plural(q.length, 'comment')} to go through`}</b>${where}
    <span class="qnav"><button class="btn sm" data-do="prevFinding" title="Previous comment ( [ )" aria-label="Previous comment" ${only ? 'disabled' : ''}>${I.prev}</button><button class="btn sm" data-do="nextFinding" title="Next comment ( ] )" ${only ? 'disabled' : ''}>${cur ? 'Next' : 'Start'}${I.chev}</button></span>
    <div class="seg"><button data-do="near" data-near="0" aria-pressed="${!near}">Whole files</button><button data-do="near" data-near="1" aria-pressed="${near}" title="Every file with comments to go through, cut down to the code around them">Near comments</button></div></div>`;
}

/** Only the code near the comments to go through, every file with some in one scroll, most severe file first. */
function nearDiff(q: QueueItem[], pr: PrDetail): string {
  const paths = [...new Set(q.map((x) => x.path))];
  return paths.map((path) => {
    const f = pr.files.find((x) => x.path === path);
    const full = f?.lines ?? [];
    const here = q.filter((x) => x.path === path);
    return `<section class="nsec"><div class="dh"><span class="mono">${esc(path)}</span><span class="cnt">${plural(here.length, 'comment')}</span><span class="end"><button class="link" data-file="${esc(path)}">Whole file${I.chev}</button></span></div>
      <div class="code" data-path="${esc(path)}">${renderDiff(path, nearLines(full, here), pr, full)}</div></section>`;
  }).join('');
}

/* ---------- Comments in the diff ---------- */

const SEV = ['P0', 'P1', 'P2', 'P3'];
const sevChip = (n: number | null | undefined) => (n == null ? '' : `<span class="sev s${n}" title="Severity ${SEV[n]}">${SEV[n]}</span>`);
const threads = (pr: PrDetail) => pr.conversation.filter((it): it is Thread => it.kind === 'thread');

/** The comments to go through on the open PR: what ] and [ step through. */
const queueNow = () => (host?.pr ? reviewQueue(host.pr, host.drafts, host.user) : []);

/**
 * The diff with comments woven in: threads and held-back comments under their lines, and the comment box.
 * `full` is the file's whole diff when `lines` is cut down to the code near comments: comments on lines cut
 * away just aren't shown, and only those on lines the diff doesn't have at all are listed above it.
 */
function renderDiff(path: string, lines: DiffLine[], pr: PrDetail, full: DiffLine[] = lines): string {
  const h = host!;
  const here = threads(pr).filter((t) => t.path === path);
  const drafts = h.drafts.filter((d) => d.path === path && !d.replyTo);
  const out = lines.map((l) => {
    let html = diffLine(l);
    if (l.kind === 'gap') return html;
    const side: 'RIGHT' | 'LEFT' = l.kind === 'del' ? 'LEFT' : 'RIGHT';
    const no = side === 'LEFT' ? l.oldNo : l.newNo;
    for (const t of here.filter((x) => side === 'RIGHT' && x.line === no)) html += threadCard(t, pr);
    for (const d of drafts.filter((x) => x.side === side && x.line === no)) html += draftCard(d);
    const c = view.composer;
    if (c && !c.replyTo && !c.editId && c.path === path && c.side === side && c.line === no) html += composerBox(c);
    return html;
  }).join('');
  // Threads on lines this diff doesn't show (outdated, or outside the changed hunks), and findings without a
  // line, still need a home.
  const elsewhere = here.filter((t) => !inDiff(full, 'RIGHT', t.line));
  const loose = drafts.filter((d) => !inDiff(full, d.side, d.line));
  return (elsewhere.length || loose.length ? `<div class="outside"><span class="lbl">Comments on lines not shown here</span>${elsewhere.map((t) => threadCard(t, pr)).join('')}${loose.map(draftCard).join('')}</div>` : '') + out;
}

/** An existing thread in the diff: its finding's severity, the conversation, and what you can do about it. */
function threadCard(t: Thread, pr: PrDetail): string {
  const h = host!;
  const replies = h.drafts.filter((d) => d.replyTo === t.id);
  const c = view.composer;
  const composing = c && c.replyTo === t.id && !c.editId;
  // Once you've answered it (a reply is held back), just offer another reply.
  const acts = t.resolved ? '' : replies.length ? `<div class="tacts"><button class="link" data-reply="${esc(t.id)}">Reply</button><button class="link" data-resolvethread="${esc(t.id)}" ${h.busy ? 'disabled' : ''} title="Resolve this conversation now, as on GitHub">Resolve</button></div>` : `<div class="tacts">
      <button class="btn sm fix" data-thread="${esc(t.id)}" title="Send this finding to your AI agent to fix">${I.spark}Fix it</button>
      <button class="btn sm" data-reply="${esc(t.id)}" data-prefill="Agreed, please fix this. " title="Held back as a reply, sent with your review">Ask the author</button>
      <button class="btn sm" data-reply="${esc(t.id)}" data-resolve="1" data-prefill="Not an issue: " title="A reply that also resolves the thread when your review is sent">Not an issue</button>
      <button class="link" data-reply="${esc(t.id)}">Reply</button><button class="link" data-resolvethread="${esc(t.id)}" ${h.busy ? 'disabled' : ''} title="Resolve this conversation now, as on GitHub">Resolve</button></div>`;
  return `<div class="tcard ${t.resolved ? 'resolved' : ''} ${view.finding === t.id ? 'current' : ''}" data-thread-id="${esc(t.id)}">
    <div class="tch">${I.com}${sevChip(t.severity)}<span class="pill ${t.resolved ? '' : 'need'}">${t.resolved ? 'Resolved' : 'Unresolved'}</span>${t.outdated ? '<span class="pill">Outdated</span>' : ''}${t.line ? `<span class="mono tl">line ${t.line}</span>` : ''}</div>
    ${t.comments.map((cm) => comment(cm, '')).join('')}${replies.map(draftCard).join('')}${composing ? composerBox(c!) : acts}</div>`;
}

/** A held-back comment, marked Pending; your agent's suggestions also say so and need keeping. */
function draftCard(d: Draft): string {
  const c = view.composer;
  if (c?.editId === d.id) return composerBox(c);
  return `<div class="drf ${d.from} ${view.finding === d.id ? 'current' : ''}" data-draft-id="${esc(d.id)}"><div class="drh"><span class="chip pend">${d.sent ? 'In your review on GitHub' : 'Pending'}</span>${d.from === 'agent' ? `<span class="chip agent">${I.spark}From your agent</span>` : ''}${sevChip(d.severity)}${d.resolve ? '<span class="chip">Resolves the thread</span>' : ''}
    <span class="end">${d.sent ? '' : `<button class="link" data-edit="${esc(d.id)}">Edit</button>`}<button class="link" data-del="${esc(d.id)}">Delete</button>${d.from === 'agent' ? `<button class="btn sm" data-keep="${esc(d.id)}">Keep</button>` : ''}</span></div>
    <div class="drb">${esc(d.body.replace(/^\*\*P[0-3]\*\*\s*/, ''))}</div></div>`;
}

function composerBox(c: Composer): string {
  const editing = !!c.editId;
  const what = c.replyTo ? (c.resolve ? 'Reply and resolve' : 'Reply') : c.startLine && c.startLine !== c.line ? `Comment on lines ${c.startLine}–${c.line}` : `Comment on line ${c.line}`;
  return `<div class="composer"><span class="lbl">${editing ? 'Edit comment' : what}</span>
    <textarea id="lbox" data-for="${esc(c.id ?? '')}" rows="3" placeholder="${c.replyTo ? 'Reply…' : 'Leave a comment'}" aria-label="${esc(what)}">${esc(c.prefill ?? '')}</textarea>
    <div class="cacts"><button class="link" data-do="composeCancel">Cancel</button>
      ${editing ? '<button class="btn sm pri" data-do="composeSave">Save</button>' : `<button class="btn sm" data-do="composeNow" ${host?.pr?.pendingReview ? 'disabled title="You have a review in progress on GitHub; add this to it instead"' : 'title="Post it right away, outside a review"'}>${c.replyTo ? 'Reply now' : 'Comment now'}</button><button class="btn sm pri" data-do="composeAdd" title="Hold it back and send it with your review">Add to review</button>`}</div></div>`;
}

function diffLine(l: DiffLine): string {
  if (l.kind === 'gap') return `<div class="hunk">${l.hidden ? `${plural(l.hidden, 'line')} hidden` : 'Lines hidden'}</div>`;
  const n = l.newNo ?? l.oldNo;
  const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
  const num = l.newNo != null ? `<button class="n" data-line="${l.newNo}" title="Open at line ${l.newNo}">${n}</button>` : `<span class="n">${n}</span>`;
  const side = l.kind === 'del' ? 'LEFT' : 'RIGHT';
  const at = side === 'LEFT' ? l.oldNo : l.newNo;
  const add = at != null ? `<button class="addc" data-cline="${side}:${at}" aria-label="Comment on line ${at}" title="Comment on this line (shift-click another to comment on a range)">+</button>` : '';
  return `<div class="ln ${l.kind}" data-at="${side}:${at ?? ''}">${add}${num}<span class="m">${mark}</span><span class="tx">${esc(l.text) || ' '}</span></div>`;
}

const base = (p: string) => p.split('/').pop() ?? p;
const dir = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

/* ---------- Description and conversation ---------- */
/**
 * GitHub's Conversation tab: the description in full, then the conversation oldest first, then the comment
 * box. Nothing is clamped; this page is for reading.
 */
function stepOverview(pr: PrDetail): string {
  const n = conversationCounts(pr.conversation);
  const jump = n.fresh ? `<div class="ovmeta"><button class="link" data-do="jumpNew">Jump to ${plural(n.fresh, 'new comment')}${I.down}</button></div>` : '';
  return `<div class="ov">
    ${pr.state === 'open' ? statusCardView(pr, host!) : ''}${jump}
    <section class="ovdesc" aria-label="Description">${description(pr)}</section>
    <section class="ovconv" aria-label="Conversation"><div class="convh"><h3 class="lbl">Conversation</h3>${convFilters(pr)}</div>
      ${conversation(filtered(pr))}</section>
    ${compose(pr)}</div>`;
}

/** The comment box, with the reviewer's one-click comments (like "@codex review") above it. */
function compose(pr: PrDetail): string {
  const h = host!;
  const busy = h.busy === 'comment';
  const acts = pr.state === 'merged' ? '' : h.actions.map((a, i) => actionState(pr, a, i, h)).join('');
  return `<div class="compose">${acts ? `<div class="acts">${acts}</div>` : ''}
    <div class="box"><textarea id="cbox" rows="1" placeholder="Leave a comment" aria-label="Leave a comment" ${busy ? 'disabled' : ''}></textarea>
    <button class="btn" data-do="comment" ${h.busy ? 'disabled' : ''}>${busy ? '<span class="spin sm"></span>' : ''}Comment</button></div></div>`;
}

/**
 * A one-click comment, shown by what has happened: not asked yet (the suggested button), asked and waiting,
 * or answered (with Ask again).
 */
function actionState(pr: PrDetail, a: CommentAction, i: number, h: HostState): string {
  const { asked, reply } = askAndReply(pr.conversation, a, h.user);
  const replied = reply && (!asked || Date.parse(reply.createdAt) >= Date.parse(asked.createdAt));
  const btn = (label: string, cls: string) => `<button class="btn sm ${cls}" data-action="${i}" ${h.busy ? 'disabled' : ''} title="Posts “${esc(a.comment)}”">${esc(label)}</button>`;
  if (replied) return `<span class="act"><span class="sub">${I.check}${esc(who(reply!.author))} replied ${ago(reply!.createdAt)} ago</span>${btn('Ask again', 'link-ish')}</span>`;
  if (asked && a.reviewer) return `<span class="act"><span class="sub"><span class="spin sm"></span>Asked ${ago(asked.createdAt)} ago · waiting for a reply</span></span>`;
  return `<span class="act">${btn(a.label, 'fix')}</span>`;
}

function description(pr: PrDetail): string {
  return pr.bodyHtml.trim() ? `<div class="md">${safe(pr.bodyHtml)}</div>` : '<p class="none">The author didn’t write a description.</p>';
}

/** GitHub's comment filters: everything, what's still open, and what you wrote. With counts. */
function convFilters(pr: PrDetail): string {
  const f = (k: View['conv'], label: string) => {
    const n = filtered(pr, k).length;
    return `<button data-conv="${k}" aria-pressed="${view.conv === k}" ${!n && view.conv !== k ? 'disabled' : ''}>${label} <span class="n">${n}</span></button>`;
  };
  return `<div class="seg convf" role="group" aria-label="Show">${f('all', 'All')}${f('unresolved', 'Unresolved')}${f('mine', 'Mine')}</div>`;
}

/** The conversation under a filter: unresolved threads, or anything the reviewer wrote or started. */
function filtered(pr: PrDetail, k: View['conv'] = view.conv): ConversationItem[] {
  const me = host?.user ?? '';
  if (k === 'unresolved') return pr.conversation.filter((it) => it.kind === 'thread' && !it.resolved);
  if (k === 'mine') return pr.conversation.filter((it) => (it.kind === 'thread' ? it.comments.some((c) => c.author === me) : it.comment.author === me));
  return pr.conversation;
}

/** Oldest first, as on GitHub; the first new comment is marked so "N new comments" can jump to it. */
function conversation(items: ConversationItem[]): string {
  if (!items.length) return '<p class="none">No comments yet.</p>';
  let marked = false;
  return [...items].sort((a, b) => Date.parse(startedAt(a)) - Date.parse(startedAt(b))).map((it) => {
    const fresh = it.kind === 'thread' ? it.comments.some((c) => c.isNew) : it.comment.isNew;
    const html = convItem(it, fresh && !marked);
    if (fresh) marked = true;
    return html;
  }).join('');
}

const VERDICT: Record<ReviewVerdict, string> = {
  approved: '<span class="pill ok">Approved</span>', changes_requested: '<span class="pill need">Changes requested</span>',
  commented: '<span class="pill">Reviewed</span>', dismissed: '<span class="pill">Dismissed</span>',
};

function convItem(it: ConversationItem, firstNew = false): string {
  const anchor = firstNew ? ' id="firstnew"' : '';
  if (it.kind !== 'thread') return `<article class="ci"${anchor}>${comment(it.comment, it.kind === 'review' ? VERDICT[it.verdict] : '')}</article>`;
  const where = `${base(it.path)}${it.line ? `:${it.line}` : ''}`;
  const me = host?.user ?? '';
  const last = it.comments.at(-1);
  // On a thread you started, say whether it's been answered.
  const answered = !it.resolved && it.comments[0]?.author === me && last ? (last.author !== me ? `<span class="ck-s run">${I.com}${esc(who(last.author))} replied</span>` : '<span class="ck-s muted">No reply yet</span>') : '';
  const state = (it.resolved ? '<span class="pill">Resolved</span>' : '<span class="pill need">Unresolved</span>') + answered;
  const fix = it.resolved ? '' : `<span class="end tacts-inline"><button class="btn sm fix" data-thread="${esc(it.id)}" title="Send this comment to your AI agent">${I.spark}Fix it</button><button class="btn sm" data-goto="${esc(it.id)}" title="Answer it in the diff: ask the author, or say it’s not an issue">Answer in diff</button><button class="btn sm" data-resolvethread="${esc(it.id)}" ${host?.busy ? 'disabled' : ''} title="Resolve this conversation now, as on GitHub">Resolve</button></span>`;
  return `<article class="ci thread"${anchor} data-thread-id="${esc(it.id)}"><div class="cih">${I.com}${sevChip(it.severity)}<button class="link mono" data-goto="${esc(it.id)}" title="Show it in the diff">${esc(where)}</button>${state}${it.outdated ? '<span class="pill">Outdated</span>' : ''}${fix}</div>
    ${it.comments.map((c) => comment(c, '')).join('')}</article>`;
}

function comment(c: Comment, badge: string): string {
  return `<div class="cm ${c.isNew ? 'new' : ''}"><div class="cmh"><b title="${esc(c.author)}">${esc(who(c.author))}</b>${badge}<span class="when">${ago(c.createdAt)} ago</span>${c.isNew ? '<span class="newtag">New</span>' : ''}
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

function prView(h: HostState): string {
  const pr = h.pr;
  if (!pr) return `<div class="crumb"><button class="home" data-do="back">${I.inbox}Review queue</button></div><div class="empty"><span class="spin"></span>Loading pull request</div>`;
  return `${crumb(pr, h)}<div class="cols">${sidebar(pr)}<main>${view.step === 'checks' ? stepChecks(pr) : view.step === 'files' ? stepFiles(pr) : stepOverview(pr)}</main></div>`;
}

const SCROLLERS = ['main', '#app > .pad', '.code', '.files', '.side', '.sc-d', '.log', '.pop.review textarea'];

function render(): void {
  if (!host) return;
  const err = host.error ? `<div class="err" role="alert">${esc(host.error)}<button class="btn sm" data-do="refresh">Try again</button></div>` : '';
  // Re-rendering replaces the text boxes; keep what the reviewer was typing in each.
  // A comment box in the diff is kept only if the same one is still open (data-for): opening another draft's
  // editor or another reply mustn't fill it with the text of the one before.
  const typing = ['cbox', 'rbody', 'lbox'].map((id) => {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    return el ? { id, owner: el.dataset.for ?? '', value: el.value, focused: document.activeElement === el, at: el.selectionStart } : null;
  });
  // Redrawing replaces every scrolling area; keep where each one was (refreshes happen on their own now).
  const scrolls = SCROLLERS.map((sel) => Array.from(app.querySelectorAll<HTMLElement>(sel)).map((el) => el.scrollTop));
  // The diff keeps its place while it shows the same thing; another file starts at the top.
  const paneWas = app.querySelector<HTMLElement>('.diffpane');
  const pane = paneWas && { shows: paneWas.dataset.shows, top: paneWas.scrollTop, anchor: diffAnchor(paneWas) };
  app.innerHTML = err + (host.view === 'pr' ? prView(host) : queue(host)) + (view.keys ? keysHelp() : '');
  applyVars();
  SCROLLERS.forEach((sel, i) => app.querySelectorAll<HTMLElement>(sel).forEach((el, j) => { const top = scrolls[i]![j]; if (top) el.scrollTop = top; }));
  const paneNow = app.querySelector<HTMLElement>('.diffpane');
  if (pane && paneNow && paneNow.dataset.shows === pane.shows) {
    paneNow.scrollTop = pane.top;
    // What you were reading stays put, even when things above it changed: a comment dealt with, a reply box
    // opened, or a thread gone outdated and moved to the box at the top of the file.
    const el = pane.anchor && findAnchor(paneNow, pane.anchor.key);
    if (el) paneNow.scrollTop += el.getBoundingClientRect().top - paneNow.getBoundingClientRect().top - pane.anchor!.top;
  }
  placeMarks();
  for (const t of typing) {
    const el = t && (document.getElementById(t.id) as HTMLTextAreaElement | null);
    if (!el || !t || (el.dataset.for ?? '') !== t.owner) continue;
    el.value = t.value;
    if (t.focused && host.busy === null) { el.focus(); el.setSelectionRange(t.at, t.at); }
  }
  // After restoring what was typed, so a prefill isn't overwritten by the box's old text.
  if (prefill) {
    const box = document.getElementById('cbox') as HTMLTextAreaElement | null;
    if (box) { box.value = prefill; box.focus(); box.dispatchEvent(new Event('input', { bubbles: true })); prefill = null; }
  }
}

/**
 * What's at the top of the diff on screen, and how far down the pane: the first code line you can see, or, when a
 * comment fills the screen, that comment. A code line comes first because comments can move (an outdated thread
 * goes to the box at the top of the file) and the code you were reading shouldn't move with them.
 */
function diffAnchor(pane: HTMLElement): { key: string; top: number } | null {
  const top = pane.getBoundingClientRect().top;
  const bottom = top + pane.clientHeight;
  const seen = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom > top && r.top < bottom; };
  const el = Array.from(pane.querySelectorAll<HTMLElement>('.ln')).find(seen) ?? Array.from(pane.querySelectorAll<HTMLElement>('[data-thread-id], [data-draft-id]')).find(seen);
  return el ? { key: anchorKey(el), top: el.getBoundingClientRect().top - top } : null;
}

const anchorKey = (el: HTMLElement) => (el.dataset.threadId ? `t:${el.dataset.threadId}` : el.dataset.draftId ? `d:${el.dataset.draftId}` : `${el.closest<HTMLElement>('[data-path]')?.dataset.path}|${el.dataset.at}`);
const findAnchor = (pane: HTMLElement, key: string) => Array.from(pane.querySelectorAll<HTMLElement>('.ln, [data-thread-id], [data-draft-id]')).find((el) => anchorKey(el) === key);

/** A mark beside the diff's scrollbar for each comment to go through, at its place in the diff; click one to go there. */
function placeMarks(): void {
  const rail = app.querySelector<HTMLElement>('.rail');
  const pane = app.querySelector<HTMLElement>('.diffpane');
  if (!rail || !pane) return;
  rail.replaceChildren();
  if (pane.scrollHeight <= pane.clientHeight) return;
  const top = pane.getBoundingClientRect().top - pane.scrollTop;
  for (const q of queueNow()) {
    const el = cardFor(q.id);
    if (!el) continue;
    const b = document.createElement('button');
    b.className = `tick ${sevTone(q.severity)} ${q.id === view.finding ? 'current' : ''}`;
    b.dataset.q = q.id;
    b.tabIndex = -1;
    b.title = `${base(q.path)}${q.line ? `:${q.line}` : ''}`;
    b.style.setProperty('--y', String((el.getBoundingClientRect().top - top) / pane.scrollHeight));
    rail.append(b);
  }
}
window.addEventListener('resize', placeMarks);

/**
 * The webview's CSP has no 'unsafe-inline', so style attributes in rendered HTML are dropped. Layout values
 * (stack depth, merge-tree lanes) go in data-vars="--l:1;--to:0" and are set here, through the CSSOM, which it allows.
 */
function applyVars(): void {
  app.querySelectorAll<HTMLElement>('[data-vars]').forEach((el) => {
    for (const pair of el.dataset.vars!.split(';')) {
      const [name, value] = pair.split(':');
      if (name && value != null) el.style.setProperty(name.trim(), value.trim());
    }
  });
}

function keysHelp(): string {
  const r = (ks: string[], t: string) => `<div class="kr">${ks.map((k) => `<kbd>${k}</kbd>`).join('')}<span>${t}</span></div>`;
  return `<div class="keys" data-do="keys"><div class="kp" role="dialog" aria-label="Keyboard shortcuts"><b>Keyboard shortcuts</b>
    <span class="lbl">Queue</span>${r(['j', 'k'], 'Move down or up')}${r(['Enter'], 'Open the pull request')}${r(['r'], 'Refresh')}
    <span class="lbl">Pull request</span>${r(['j', 'k'], 'Next or previous pull request')}${r(['n', 'p'], 'Next or previous file')}${r(['v'], 'Toggle viewed on this file')}${r(['1', '2', '3'], 'Overview, Checks, Files changed')}${r(['c'], 'Comment on a line')}${r([']', '['], 'Next or previous finding')}${r(['r'], 'Reply to the finding')}${r(['⌘⇧↵'], 'Finish your review')}${r(['a'], 'Approve')}${r(['Esc'], 'Back to the queue')}${r(['?'], 'Show or hide this list')}</div></div>`;
}

/* ---------- Events ---------- */
window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  if (msg.type === 'state') {
    const pr = msg.state.pr;
    if (pr && prKey(pr) !== view.pr) {
      // First look, or new comments: start on Overview for the context. Otherwise pick up the files.
      const start: Step = !pr.seenBefore || conversationCounts(pr.conversation).fresh ? 'overview' : 'files';
      // A re-review opens the conversation on your own threads: what became of what you asked for.
      view = { ...view, pr: prKey(pr), file: null, onlyNew: false, step: start, menu: null, reviewEvent: null, composer: null, finding: null, part: null, cardOpen: false, conv: isReReview(pr) ? 'mine' : 'all' };
      vscode.setState(view);
      // Another PR's comments won't be shown again soon: don't keep their cleaned HTML for the whole session.
      cleaned.clear();
    }
    host = msg.state;
    render();
  } else if (msg.type === 'toast') {
    const t = document.getElementById('toast')!;
    t.textContent = msg.text;
    t.classList.add('show');
    clearTimeout((t as unknown as { timer?: number }).timer);
    // Long enough to read: about a second per 20 characters, between 2.5 and 8 seconds.
    (t as unknown as { timer?: number }).timer = window.setTimeout(() => t.classList.remove('show'), Math.min(8000, Math.max(2500, msg.text.length * 50)));
  } else if (msg.type === 'unsent') {
    // Sending failed after the box was cleared: put the text back where it was typed.
    const m = msg.msg;
    if (m.type === 'comment') { prefill = m.body; render(); }
    else if (m.type === 'submitReview') {
      save({ menu: 'review', reviewEvent: m.event });
      const box = document.getElementById('rbody') as HTMLTextAreaElement | null;
      if (box) box.value = m.body;
    } else {
      const { body, ...at } = m.draft;
      save({ step: 'files', file: at.path, near: false, composer: { ...at, id: composerId(), prefill: body } });
      document.getElementById('lbox')?.focus();
    }
  }
});

// The comment box grows with what's typed, up to its max height.
document.addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (t.id !== 'cbox') return;
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t instanceof HTMLInputElement && t.name === 'revent') save({ reviewEvent: t.value as ReviewEvent });
  else if (t.id === 'repofilter') save({ repo: (t as HTMLSelectElement).value, sel: 0 });
  // "*" is every milestone; "=Title" one of them, and "=" alone those without one.
  else if (t.id === 'msfilter') { const v = (t as HTMLSelectElement).value; save({ milestone: v === '*' ? null : v.slice(1), sel: 0 }); }
  else if (t.id === 'method') save({ method: t.value as MergeMethod });
  else if (t instanceof HTMLInputElement && t.dataset.viewed) send({ type: 'setViewed', path: t.dataset.viewed, viewed: t.checked });
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // Menus: a toggle opens or closes its own; any click outside an open menu closes it.
  const toggle = target.closest<HTMLElement>('[data-menu]');
  if (toggle && !(toggle as HTMLButtonElement).disabled) { const m = toggle.dataset.menu as View['menu']; save({ menu: view.menu === m ? null : m }); return; }
  const pick = target.closest<HTMLElement>('[data-method-pick]');
  if (pick) { save({ method: pick.dataset.methodPick as MergeMethod, menu: null }); return; }
  if (view.menu && !target.closest('.pop')) { view.menu = null; vscode.setState(view); if (!target.closest('[data-do],[data-step],[data-ext],[data-open]')) { render(); return; } }
  // Links inside descriptions and comments open in the browser, never inside the panel.
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.md a[href], a.lin[href]');
  if (a) {
    e.preventDefault();
    if (/^https?:/.test(a.href)) send({ type: 'openExternal', url: a.href });
    return;
  }
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-resolvethread],[data-open],[data-filter],[data-conv],[data-part],[data-layout],[data-cline],[data-reply],[data-edit],[data-del],[data-keep],[data-goto],[data-step],[data-fix],[data-thread],[data-action],[data-file],[data-onlynew],[data-line],[data-ext],[data-q],[data-do]');
  if (!t || (t as HTMLButtonElement).disabled) return;
  // An action picked from a menu closes it.
  if (view.menu && t.closest('.pop') && !t.dataset.part && t.dataset.do !== 'cardOpen') view.menu = null;
  const d = t.dataset;
  if (d.resolvethread) { send({ type: 'resolveThread', id: d.resolvethread }); advanceFrom(d.resolvethread); }
  else if (d.open) send({ type: 'openPr', key: d.open });
  else if (d.filter) save({ filter: d.filter as Filter });
  else if (d.layout) save({ layout: d.layout as View['layout'], sel: 0 });
  else if (d.conv) save({ conv: d.conv as View['conv'], step: 'overview' });
  else if (d.part) save({ part: view.part === d.part ? null : (d.part as PartKey) });
  else if (d.step) save({ step: d.step as Step });
  else if (d.fix) send({ type: 'fixWithAgent', check: d.fix });
  else if (d.thread) { send({ type: 'fixThread', id: d.thread }); advanceFrom(d.thread); }
  else if (d.action) { const a: CommentAction | undefined = host?.actions[Number(d.action)]; if (a) send({ type: 'comment', body: a.comment }); }
  else if (d.file) { save({ file: d.file, step: 'files', onlyNew: d.onlynew === '1', near: false }); if (d.onlynew === '1') showFirstChange(); }
  else if (d.onlynew) { save({ onlyNew: d.onlynew === '1' }); if (d.onlynew === '1') showFirstChange(); }
  else if (d.line && view.file) send({ type: 'openFile', path: view.file, line: Number(d.line) });
  else if (d.cline && view.file) openComposer(d.cline, (e as MouseEvent).shiftKey);
  else if (d.reply) save({ composer: replyTo(d.reply, d.resolve === '1', d.prefill), finding: d.reply });
  else if (d.edit) { const dr = host?.drafts.find((x) => x.id === d.edit); if (dr) save({ composer: { id: composerId(), path: dr.path, line: dr.line, side: dr.side, replyTo: dr.replyTo, resolve: dr.resolve, editId: dr.id, prefill: dr.body } }); }
  else if (d.del) { send({ type: 'deleteDraft', id: d.del }); advanceFrom(d.del); }
  else if (d.keep) { send({ type: 'keepDraft', id: d.keep }); advanceFrom(d.keep); }
  else if (d.goto) goToItem(d.goto);
  else if (d.q) goToItem(d.q);
  else if (d.ext) send({ type: 'openExternal', url: d.ext });
  else if (d.do === 'back') send({ type: 'back' });
  else if (d.do === 'refresh') send({ type: 'refresh' });
  else if (d.do === 'approve') send({ type: 'approve' });
  else if (d.do === 'merge') send({ type: 'merge', method: (d.method as MergeMethod | undefined) ?? 'merge' });
  else if (d.do === 'updateBranch') send({ type: 'updateBranch' });
  else if (d.do === 'toDraft') send({ type: 'setDraft', draft: true });
  else if (d.do === 'readyForReview') send({ type: 'setDraft', draft: false });
  else if (d.do === 'keys') save({ keys: !view.keys });
  else if (d.do === 'switchRepo') send({ type: 'switchRepository' });
  else if (d.do === 'togglePassed') save({ showPassed: !view.showPassed });
  else if (d.do === 'jumpNew') document.getElementById('firstnew')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else if (d.do === 'fixConflicts') send({ type: 'fixConflicts' });
  else if (d.do === 'mergeDependabot') send({ type: 'mergeDependabot' });
  else if (d.do === 'closeDependabot') send({ type: 'closeDependabot' });
  else if (d.do === 'comment') postComment();
  else if (d.do === 'submitReview') submitReview();
  else if (d.do === 'composeCancel') save({ composer: null });
  else if (d.do === 'composeAdd' || d.do === 'composeNow' || d.do === 'composeSave') finishComposer(d.do);
  else if (d.do === 'nextFinding') stepFinding(1);
  else if (d.do === 'prevFinding') stepFinding(-1);
  else if (d.do === 'near') {
    // Showing only code near comments starts at the first one, unless you're already on one.
    const on = d.near === '1';
    const q = queueNow();
    const start = on && !q.some((x) => x.id === view.finding) ? q[0]?.id ?? null : view.finding;
    save({ near: on, finding: start });
    if (start) cardFor(start)?.scrollIntoView({ block: 'center' });
  }
  else if (d.do === 'cardOpen') save({ cardOpen: !view.cardOpen, part: null });
  else if (d.do === 'reviewWithAgent') send({ type: 'reviewWithAgent' });
  else if (d.do === 'dependabotRebase') send({ type: 'comment', body: '@dependabot rebase' });
  else if (d.do === 'askResolve' && host?.pr) {
    // A ready-to-send comment in Overview's box, for you to read and send.
    prefill = `@${host.pr.author} This branch has conflicts with ${host.pr.baseRef}. Could you merge ${host.pr.baseRef} into it and resolve them? I’ll keep reviewing the code meanwhile.`;
    save({ step: 'overview' });
  }
  else if (d.do === 'dismissNotice') send({ type: 'dismissNotice' });
  else if (d.do === 'threads') {
    save({ step: 'overview' });
    const open = Array.from(document.querySelectorAll<HTMLElement>('[data-thread-id]')).find((el) => el.querySelector('.pill.need'));
    open?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

function replyTo(id: string, resolve: boolean, prefill?: string): Composer | null {
  const t = host?.pr && threads(host.pr).find((x) => x.id === id);
  return t ? { id: composerId(), path: t.path, line: t.line, side: 'RIGHT', replyTo: id, resolve, prefill } : null;
}

/** Each comment box opened gets its own id, so a redraw knows whether the box on screen is still the same one. */
const composerId = () => Math.random().toString(36).slice(2, 10);

/** Opens the comment box on a diff line; shift-click with a box open on the same side makes it a range. */
function openComposer(at: string, range: boolean): void {
  const [side, n] = at.split(':') as ['RIGHT' | 'LEFT', string];
  const line = Number(n);
  const c = view.composer;
  if (range && c && !c.replyTo && !c.editId && c.path === view.file && c.side === side && c.line != null && c.line !== line) {
    save({ composer: { ...c, startLine: Math.min(c.line, line), line: Math.max(c.line, line) } });
  } else save({ composer: { id: composerId(), path: view.file!, line, side } });
  document.getElementById('lbox')?.focus();
}

function finishComposer(how: 'composeAdd' | 'composeNow' | 'composeSave'): void {
  const c = view.composer;
  const body = (document.getElementById('lbox') as HTMLTextAreaElement | null)?.value.trim() ?? '';
  if (!c || !body) { document.getElementById('lbox')?.focus(); return; }
  const draft = { path: c.path, line: c.line, side: c.side, startLine: c.startLine ?? null, replyTo: c.replyTo, resolve: c.resolve, body };
  if (how === 'composeSave' && c.editId) send({ type: 'editDraft', id: c.editId, body });
  else send({ type: how === 'composeNow' ? 'commentNow' : 'addDraft', draft });
  save({ composer: null });
  if (how !== 'composeSave') advanceFrom(c.replyTo);
}

/**
 * Shows a thread or a held-back comment in the diff, scrolled to it. Showing only code near comments stays on
 * if it's one to go through; anything else (a resolved thread, say) opens its whole file.
 */
function goToItem(id: string): void {
  const pr = host?.pr;
  if (!pr) return;
  const path = threads(pr).find((x) => x.id === id)?.path ?? host!.drafts.find((d) => d.id === id)?.path;
  if (path == null) return;
  const near = view.near && queueNow().some((x) => x.id === id);
  save({ step: 'files', onlyNew: false, finding: id, near, ...(near ? {} : { file: path }) });
  const card = cardFor(id);
  card?.scrollIntoView({ block: 'center' });
  if (card) flash([card]);
}

/** Lights up what you were just taken to for a moment, so it's clear where you landed. */
function flash(els: HTMLElement[]): void {
  for (const el of els) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation when it's the same element again
    el.classList.add('flash');
  }
}

/** "Since you looked": scroll to the first lines that changed, and light them up. */
function showFirstChange(): void {
  const first = app.querySelector<HTMLElement>('.diffpane .ln.add, .diffpane .ln.del');
  if (!first) return;
  const run = [first];
  for (let n = first.nextElementSibling; n instanceof HTMLElement && n.matches('.ln.add, .ln.del'); n = n.nextElementSibling) run.push(n);
  first.scrollIntoView({ block: 'center' });
  flash(run);
}

const cardFor = (id: string) => app.querySelector<HTMLElement>(`.diffpane [data-thread-id="${CSS.escape(id)}"], .diffpane [data-draft-id="${CSS.escape(id)}"]`);

/** ] and [: the next or previous comment to go through, most severe first. */
function stepFinding(dir: 1 | -1): void {
  const next = stepQueue(queueNow(), view.finding, dir);
  if (next) goToItem(next.id);
}

/**
 * Once you've dealt with the comment you're on (answered it, sent it to your agent, kept or deleted your
 * agent's suggestion), go on to the next one. Only in Files changed, and only for the current comment.
 */
function advanceFrom(id: string | undefined): void {
  if (!id || id !== view.finding || view.step !== 'files') return;
  const next = stepQueue(queueNow(), id, 1);
  if (next) goToItem(next.id);
  else save({ finding: null });
}

function submitReview(): void {
  const pr = host?.pr;
  if (!pr) return;
  const event = verdict(pr);
  const box = document.getElementById('rbody') as HTMLTextAreaElement | null;
  send({ type: 'submitReview', event, body: box?.value ?? '' });
  if (event !== 'REQUEST_CHANGES' || box?.value.trim()) { if (box) box.value = ''; save({ menu: null }); }
}

function postComment(): void {
  const box = document.getElementById('cbox') as HTMLTextAreaElement | null;
  const body = box?.value.trim();
  if (!box || !body) { box?.focus(); return; }
  send({ type: 'comment', body });
  box.value = '';
}

/** The diff line under the pointer, for c. */
let hovered: string | undefined;
document.addEventListener('mouseover', (e) => { const ln = (e.target as HTMLElement).closest<HTMLElement>('.ln'); if (ln) hovered = ln.dataset.at; });

document.addEventListener('mousemove', () => {
  if (!kbd) return;
  kbd = false;
  document.querySelector('.qrow.sel')?.classList.remove('sel');
});

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  // ⌘/Ctrl+Enter posts the comment being typed; in the diff's box it adds it to your review.
  const tid = (e.target as HTMLElement).id;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey && host?.pr) {
    // ⌘⇧Enter: finish the review (open the panel, or send it when it's open).
    e.preventDefault();
    if (view.menu === 'review') submitReview(); else save({ menu: 'review' });
    return;
  }
  if (tid === 'cbox' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); return; }
  if (tid === 'lbox' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finishComposer(view.composer?.editId ? 'composeSave' : 'composeAdd'); return; }
  if (tid === 'lbox' && e.key === 'Escape') { save({ composer: null }); return; }
  if (!host || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const k = e.key;
  if (k === '?') { save({ keys: !view.keys }); return; }
  if (view.keys) { if (k === 'Escape') save({ keys: false }); return; }
  if (view.menu && k === 'Escape') { save({ menu: null }); return; }
  const rows = visibleQueue(host);
  if (host.view === 'queue') {
    // The first press shows the cursor where it is; later presses move it.
    if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
      const shown = kbd;
      kbd = true;
      const step = k === 'j' || k === 'ArrowDown' ? 1 : -1;
      save({ sel: shown ? Math.min(rows.length - 1, Math.max(0, view.sel + step)) : view.sel });
      e.preventDefault();
    }
    else if (k === 'Enter' && kbd && rows[view.sel] && !(e.target as HTMLElement).closest('button')) send({ type: 'openPr', key: prKey(rows[view.sel]!) });
    else if (k === 'r') send({ type: 'refresh' });
    return;
  }
  const pr = host.pr;
  if (!pr) return;
  if (k === 'Escape') send({ type: 'back' });
  else if (k === 'j' || k === 'k') {
    if (!rows.length) return;
    const at = rows.findIndex((p) => prKey(p) === prKey(pr));
    const next = rows[(at + (k === 'j' ? 1 : -1) + rows.length) % rows.length]!;
    view.sel = rows.indexOf(next);
    send({ type: 'openPr', key: prKey(next) });
  } else if (k === 'n' || k === 'p') {
    const i = Math.max(0, pr.files.findIndex((f) => f.path === view.file));
    const f = pr.files[Math.min(pr.files.length - 1, Math.max(0, i + (k === 'n' ? 1 : -1)))];
    if (f) save({ file: f.path, step: 'files', onlyNew: false });
  } else if (k === 'v' && view.step === 'files' && view.file) {
    const f = pr.files.find((x) => x.path === view.file);
    if (f) send({ type: 'setViewed', path: f.path, viewed: f.viewed !== 'viewed' });
  } else if (k === ']' || k === '[') stepFinding(k === ']' ? 1 : -1);
  else if (k === 'c' && view.step === 'files') {
    // Comment on the line under the pointer, or the first changed line of this file.
    const at = hovered ?? document.querySelector<HTMLElement>('.ln.add, .ln.del')?.dataset.at;
    if (at && !at.endsWith(':')) { e.preventDefault(); openComposer(at, false); }
  } else if (k === 'r' && view.finding) { e.preventDefault(); save({ step: 'files', composer: replyTo(view.finding, false) }); document.getElementById('lbox')?.focus(); }
  else if (k === '1') save({ step: 'overview' });
  else if (k === '2') save({ step: 'checks' });
  else if (k === '3') save({ step: 'files' });
  else if (k === 'a' && pr.state !== 'merged' && !pr.mine && (pr.myReview !== 'approved' || isReReview(pr))) {
    // With comments held back (here or in a review in progress on GitHub), approving opens the review so you see them go too.
    if (host.drafts.some((d) => d.from === 'you') || pr.pendingReview?.comments) save({ menu: 'review', reviewEvent: 'APPROVE' });
    else send({ type: 'approve' });
  }
});

send({ type: 'ready' });
