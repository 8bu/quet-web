// Collaborator labelling screen (/p/:slug): label-studio layout (prototypes/v2-a-label-studio.html).
// Offsets are Unicode code points (end exclusive); span text always comes from the shared cpSlice.

import type { Label, Schema, Span, SpanField } from '../shared/schema';
import { SchemaError, cpSlice, isNullFor, normalizeLabel, parseSchema } from '../shared/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Project {
  slug: string;
  name: string;
  schema: unknown;
  items: number;
}

interface ItemRow {
  id: string;
  position: number;
  text: string;
  label: Label | null;
}

interface ItemsPage {
  items: ItemRow[];
  total: number;
}

interface Piece { s: number; e: number; tok: number }
interface Tokens { cps: string[]; toks: Array<{ s: number; e: number }>; pieces: Piece[] }

interface Rec {
  id: string;
  text: string;
  label: Label | null; // my saved label
  tk: Tokens | null;
}

/** Unsaved edits. A span absent from `spans` is "not marked yet"; `null` means "there is none". */
interface Draft {
  type: string | null;
  spans: Record<string, Span | null | undefined>;
  status: Record<string, string>;
  unsure: boolean;
  note: string;
}

type Hist =
  | { kind: 'draft'; idx: number; prev: Draft | undefined; active: number }
  | { kind: 'save'; idx: number; id: string; prevLabel: Label | null; prevDraft: Draft | undefined; active: number };

interface Msg { text: string; tone: string; action?: number }

class Ended extends Error {}
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const PAGE = 200;
const COMPLETE = 'complete';
const UNSURE = 'uncertain';
const RESERVED_KEYS = new Set(['n', 'c', 'u', 's', 'z']);
const NEED_NOTE = 'Add a note: what is unclear?';
const svg = (d: string): string =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_CHECK = svg('<path d="M20 6 9 17l-5-5"/>');
const ICON_X = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const ICON_ENTER = svg('<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>');

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clone = <T>(o: T): T => structuredClone(o);

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const $ = {
  projName: el('projName'),
  segs: el('segs'),
  count: el('count'),
  loadNote: el('loadNote'),
  fatal: el('fatal'),
  stage: el('stage'),
  foot: el('foot'),
  slots: el('slots'),
  note: el('note'),
  card: el('card'),
  hint: el('hintrow'),
  types: el('types'),
  state: el('state'),
  bmsg: el('bmsg'),
  noteRow: el('noteRow'),
  noteIn: el<HTMLInputElement>('noteIn'),
  noteHint: el('noteHint'),
  noteX: el('noteX'),
  help: el('help'),
  helpBody: el('helpBody'),
  helpBtn: el('helpBtn'),
  tip: el('tip'),
  bUndo: el<HTMLButtonElement>('bUndo'),
  bDisc: el<HTMLButtonElement>('bDisc'),
  bUnsure: el<HTMLButtonElement>('bUnsure'),
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (method !== 'GET') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.href = '/';
    throw new Ended('session ended');
  }
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') msg = data.error;
    } catch {
      // keep the generic message
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let project: Project;
let S: Schema;
let base = '';
let recs: Rec[] = [];
let byId = new Set<string>();
let total = 0;
let ready = false;
let busy = false;
let idx = 0;
let active = 0;
let cursor: { a: number; b: number } | null = null;
let lastMark: { idx: number; slot: number; anchor: number } | null = null;
let drag: { a: number; b: number; shift: boolean; moved: boolean } | null = null;
let imsgState: Msg | null = null;
let bmsgState: Msg | null = null;
let touched = false;
let autoPlace = false;
let labelled = 0;
let slotKeys: string[] = [];
let completeOk = false;
let unsureOk = false;
let skipStatus: string | null = null;
const drafts = new Map<number, Draft>();
let history: Hist[] = [];

// ---------------------------------------------------------------------------
// Schema-derived helpers
// ---------------------------------------------------------------------------

const spanLabel = (f: SpanField): string => cap(f.name.replace(/_/g, ' '));
const nTypeKeys = (): number => Math.min(9, S.types.length);

/** First clause of a definition, cut to a chip-sized gloss. */
function gloss(desc: string): string {
  const t = desc.replace(/\s+/g, ' ').trim();
  if (t === '') return '';
  const m = /^[^.;:,(]+/.exec(t);
  const clause = (m ? m[0] : t).trim();
  if (clause.length <= 44) return clause;
  const cut = clause.slice(0, 44);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,]+$/, '')}\u2026`;
}

const statusLabel = (name: string): string => (name === COMPLETE ? 'Sure' : name === UNSURE ? 'Unsure' : cap(name));

const applicable = (d: Draft, k: number): boolean => !isNullFor(S.spans[k]!, d.type);

/** Spans of this draft whose status is "uncertain" (those need a note). */
const unsureSpans = (d: Draft): SpanField[] =>
  S.spans.filter((f) => applicable(d, S.spans.indexOf(f)) && f.statuses.includes(UNSURE) && (d.status[f.name] ?? f.statuses[0]) === UNSURE);

const needsNote = (d: Draft): boolean => d.unsure || unsureSpans(d).length > 0;
const noteShown = (d: Draft): boolean => needsNote(d) || d.note.trim() !== '';

// ---------------------------------------------------------------------------
// Tokens: whitespace words, edge punctuation trimmed, inner kept; offsets in code points
// ---------------------------------------------------------------------------

const isWs = (c: string): boolean => /\s/.test(c);
const isPunct = (c: string): boolean => !/[\p{L}\p{N}\p{M}]/u.test(c);

function tokenize(text: string): Tokens {
  const cps = Array.from(text);
  const n = cps.length;
  const toks: Tokens['toks'] = [];
  const pieces: Piece[] = [];
  let i = 0;
  while (i < n) {
    if (isWs(cps[i]!)) {
      let j = i;
      while (j < n && isWs(cps[j]!)) j++;
      pieces.push({ s: i, e: j, tok: -1 });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isWs(cps[j]!)) j++;
    let a = i;
    let b = j;
    while (a < b && isPunct(cps[a]!)) a++;
    while (b > a && isPunct(cps[b - 1]!)) b--;
    if (a > i) pieces.push({ s: i, e: a, tok: -1 });
    if (b > a) {
      toks.push({ s: a, e: b });
      pieces.push({ s: a, e: b, tok: toks.length - 1 });
    }
    if (j > b) pieces.push({ s: b, e: j, tok: -1 });
    i = j;
  }
  return { cps, toks, pieces };
}

const tkOf = (r: Rec): Tokens => (r.tk ??= tokenize(r.text));
const sliceText = (r: Rec, s: number, e: number): string => tkOf(r).cps.slice(s, e).join('');

function asSpan(v: unknown): Span | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.start === 'number' && typeof o.end === 'number'
    ? { text: o.text, start: o.start, end: o.end }
    : null;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const emptyDraft = (): Draft => ({ type: null, spans: {}, status: {}, unsure: false, note: '' });

function draftFromLabel(L: Label | null): Draft {
  const d = emptyDraft();
  if (!L) return d;
  d.unsure = L.annotation_status === UNSURE;
  d.note = typeof L.note === 'string' ? L.note : '';
  if (S.null_label_statuses.includes(L.annotation_status)) {
    for (const f of S.spans) d.spans[f.name] = null;
    return d;
  }
  d.type = typeof L.type === 'string' ? L.type : null;
  for (const f of S.spans) d.spans[f.name] = asSpan(L[f.name]);
  const ss = L.span_status;
  if (ss && typeof ss === 'object') {
    for (const [k, val] of Object.entries(ss)) if (typeof val === 'string') d.status[k] = val;
  }
  return d;
}

const baseline = (i: number): Draft => draftFromLabel(recs[i]?.label ?? null);
const getDraft = (i: number): Draft => drafts.get(i) ?? baseline(i);
const cur = (): Draft => getDraft(idx);
const curRec = (): Rec => {
  const r = recs[idx];
  if (!r) throw new Error('no current record');
  return r;
};

function spanKey(v: Span | null | undefined): string {
  return v === undefined ? 'u' : v === null ? 'n' : `${v.start},${v.end}`;
}
function dkey(d: Draft): string {
  return JSON.stringify([
    d.type,
    S.spans.map((f) => (isNullFor(f, d.type) ? 'x' : [spanKey(d.spans[f.name]), f.statuses.length ? (d.status[f.name] ?? f.statuses[0]) : ''])),
    d.unsure,
    d.note.trim(),
  ]);
}
const dirty = (i: number): boolean => dkey(getDraft(i)) !== dkey(baseline(i));

/** The wire label for `status` + `d`; normalizeLabel applies null_label_statuses and span-status defaults. */
function buildLabel(r: Rec, status: string, d: Draft): Label {
  const clears = S.null_label_statuses.includes(status);
  const raw: Label = { id: r.id, annotation_status: status, type: clears ? null : d.type };
  const ss: Record<string, string> = {};
  for (const f of S.spans) {
    const locked = isNullFor(f, d.type);
    raw[f.name] = clears || locked ? null : (d.spans[f.name] ?? null);
    const first = f.statuses[0];
    if (first !== undefined && !locked && !clears) ss[f.name] = d.status[f.name] ?? first;
  }
  if (Object.keys(ss).length > 0) raw.span_status = ss;
  const note = d.note.trim();
  if (!clears && note !== '') raw.note = note;
  return normalizeLabel(S, raw);
}

function pushHist(): void {
  history.push({ kind: 'draft', idx, prev: drafts.has(idx) ? clone(drafts.get(idx)!) : undefined, active });
  if (history.length > 200) history.shift();
}

function mutate(fn: (d: Draft) => void): void {
  pushHist();
  const d = clone(cur());
  fn(d);
  drafts.set(idx, d);
}

function firstOpen(d: Draft, fallback: number): number {
  const k = S.spans.findIndex((f, i) => applicable(d, i) && d.spans[f.name] === undefined);
  return k >= 0 ? k : fallback;
}
function firstApplicable(d: Draft): number {
  const k = S.spans.findIndex((_, i) => applicable(d, i));
  return k >= 0 ? k : 0;
}
const defaultActive = (d: Draft): number => firstOpen(d, firstApplicable(d));
function nextOpenAfter(d: Draft, slot: number): number {
  const n = S.spans.length;
  for (let o = 1; o < n; o++) {
    const k = (slot + o) % n;
    if (applicable(d, k) && d.spans[S.spans[k]!.name] === undefined) return k;
  }
  return slot;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

let imT = 0;
let bmT = 0;
function imsg(text: string, tone = 'err'): void {
  imsgState = { text, tone };
  clearTimeout(imT);
  imT = window.setTimeout(() => {
    imsgState = null;
    renderHint();
  }, 4500);
  renderHint();
}
function bmsg(text: string, tone = 'err', action?: number, ms?: number): void {
  bmsgState = { text, tone, action };
  clearTimeout(bmT);
  bmT = window.setTimeout(() => {
    bmsgState = null;
    renderBar();
  }, ms ?? (tone === 'err' ? 9000 : 5000));
  renderBar();
}
function clearMsgs(): void {
  imsgState = null;
  bmsgState = null;
  clearTimeout(imT);
  clearTimeout(bmT);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const cache = new Map<string, string>();
function setHTML(node: HTMLElement, key: string, html: string): void {
  if (cache.get(key) !== html) {
    cache.set(key, html);
    node.innerHTML = html;
  }
}

function renderHeader(): void {
  $.segs.setAttribute('aria-valuenow', String(labelled));
  $.segs.setAttribute('aria-valuemax', String(total));
  let bar = $.segs.firstElementChild as HTMLElement | null;
  if (!bar) {
    bar = document.createElement('i');
    $.segs.appendChild(bar);
  }
  bar.style.width = `${total > 0 ? ((labelled / total) * 100).toFixed(2) : 0}%`;
  setHTML($.count, 'count', `Note ${idx + 1} of ${total}<small>${labelled} saved</small>`);
}

function slotHTML(k: number, d: Draft): string {
  const f = S.spans[k]!;
  const locked = !applicable(d, k);
  const v = d.spans[f.name];
  const act = active === k && !locked;
  const key = slotKeys[k] ?? '';
  const label = spanLabel(f);
  let val: string;
  let off = '';
  if (locked) val = `<span class="sv locked">none (${esc(d.type ?? '')})</span>`;
  else if (v === undefined) val = '<span class="sv unset">not marked</span>';
  else if (v === null) val = '<span class="sv none">None <small>not in the note</small></span>';
  else {
    val = `<span class="sv">${esc(v.text)}</span>`;
    off = `<span class="off">[${v.start},${v.end})</span>`;
  }
  const st = d.status[f.name] ?? f.statuses[0] ?? '';
  const nonDefault = f.statuses.length > 0 && st !== f.statuses[0];
  const un = nonDefault && !locked ? `<span class="un">${esc(statusLabel(st).toLowerCase())}</span>` : '';
  let acts = '';
  if (f.statuses.length > 0 && !locked) {
    const segs = f.statuses
      .map((s) => `<span class="${s === st ? 'on' : ''}">${esc(statusLabel(s))}</span>`)
      .join('');
    acts += `<button class="mini stat${st === UNSURE ? ' u' : ''}" type="button" data-act="toggle" data-slot="${k}" aria-pressed="${nonDefault}" aria-label="${esc(label)} is ${esc(statusLabel(st).toLowerCase())}; change">${segs}${act ? '<kbd class="kb">c</kbd>' : ''}</button>`;
  }
  if (!locked) {
    acts += `<button class="mini" type="button" data-act="none" data-slot="${k}" aria-label="Mark ${esc(label)} as none">None${act ? '<kbd class="kb">n</kbd>' : ''}</button>`;
    if (v !== undefined) acts += `<button class="mini x" type="button" data-act="clear" data-slot="${k}" aria-label="Clear ${esc(label)}" title="Clear">${ICON_X}</button>`;
  }
  const kbd = key ? `<kbd class="kb">${esc(key)}</kbd>` : '';
  const kbd2 = key ? `<kbd class="key">${esc(key)}</kbd>` : '';
  return `<div class="slot s${k % 5}${act ? ' active' : ''}${locked ? ' locked' : ''}" data-slot="${k}">
    <button class="slot-main" type="button" data-act="pick" data-slot="${k}" aria-pressed="${act}" title="${esc(f.description)}">
      ${kbd}
      <span class="stack"><span class="sl">${esc(label)}${kbd2}${off}${un}</span>${val}</span>
    </button><div class="acts">${acts}</div></div>`;
}

function renderSlots(): void {
  const d = cur();
  $.slots.style.setProperty('--n', String(Math.min(S.spans.length, 3)));
  setHTML($.slots, 'slots', S.spans.map((_, k) => slotHTML(k, d)).join('') + `<!--${idx}-->`);
}

function renderNote(): void {
  const d = cur();
  const r = curRec();
  const tk = tkOf(r);
  const cs = cursor ? [Math.min(cursor.a, cursor.b), Math.max(cursor.a, cursor.b)] : null;
  let h = '';
  for (const p of tk.pieces) {
    let cls = '';
    S.spans.forEach((f, k) => {
      const v = d.spans[f.name];
      if (v && applicable(d, k) && p.s >= v.start && p.e <= v.end) {
        cls = `hl s${k % 5}${f.statuses.length > 0 && (d.status[f.name] ?? f.statuses[0]) === UNSURE ? ' unsure' : ''}`;
      }
    });
    const txt = esc(tk.cps.slice(p.s, p.e).join(''));
    if (p.tok < 0) h += cls ? `<span class="gap ${cls}">${txt}</span>` : txt;
    else {
      const isCur = cs !== null && p.tok >= cs[0]! && p.tok <= cs[1]!;
      h += `<span class="tok ${cls}${isCur ? ' cur' : ''}" data-i="${p.tok}">${txt}</span>`;
    }
  }
  setHTML($.note, 'note', h);
  $.card.className = `card ${applicable(d, active) ? `a${active % 5}` : 'a-none'}`;
}

function renderHint(): void {
  const d = cur();
  let h: string;
  const err = !!imsgState && imsgState.tone !== 'info';
  const icon = err
    ? '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
  if (imsgState) h = `<span class="imsg ${imsgState.tone === 'info' ? 'info' : ''}" role="alert">${esc(imsgState.text)}</span>`;
  else {
    const r = recs[idx];
    const L = r?.label;
    const k = applicable(d, active) ? active : firstApplicable(d);
    const f = S.spans[k]!;
    if (L && S.null_label_statuses.includes(L.annotation_status) && !dirty(idx)) {
      const names = ['type', ...S.spans.map((x) => x.name)];
      h = `<span>Skipped: ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' and ' : ''}${names[names.length - 1]} are saved as none. Pick a type to relabel.</span>`;
    } else {
      h = `<span>Click a word to set <b class="s${k % 5}">${esc(spanLabel(f))}</b>. Shift+click or drag takes several words.</span>`;
    }
  }
  const keys =
    '<div class="callout hk"><kbd>&uarr;</kbd><kbd>&darr;</kbd><span>word</span> <kbd>Shift</kbd><span>extend</span> <kbd>Space</kbd><span>mark</span>' +
    (S.spans.length > 1 ? ' <kbd>Tab</kbd><span>switch slot</span>' : '') +
    '</div>';
  setHTML($.hint, 'hint', `<div class="callout msg${err ? ' err' : ''}">${icon}${h}</div>${keys}`);
}

function renderTypes(): void {
  const d = cur();
  $.types.style.setProperty('--cols', String(Math.max(1, Math.min(4, S.types.length))));
  setHTML(
    $.types,
    'types',
    S.types
      .map((t, i) => {
        const g = gloss(t.description);
        const key = i < 9 ? `<kbd class="kb">${i + 1}</kbd>` : '';
        return `<button class="type" type="button" data-i="${i}" aria-pressed="${d.type === t.name}" aria-label="${i < 9 ? `${i + 1} ` : ''}${esc(t.name)}${g ? `: ${esc(g)}` : ''}">
    ${key}<span><span class="tn">${esc(t.name)}</span>${g ? `<span class="tg">${esc(g)}</span>` : ''}</span></button>`;
      })
      .join('') + `<!--${d.type}-->`,
  );
}

function renderNoteRow(): void {
  const d = cur();
  const show = noteShown(d);
  $.noteRow.hidden = !show;
  if (!show) return;
  if ($.noteIn.value !== d.note) $.noteIn.value = d.note;
  const us = unsureSpans(d)[0];
  $.noteHint.innerHTML = d.unsure
    ? `<kbd>${ICON_ENTER}</kbd> saves as ${UNSURE} <kbd>Esc</kbd> back to keys`
    : `<kbd>${ICON_ENTER}</kbd> completes with ${esc(us ? spanLabel(us) : 'a span')} unsure <kbd>Esc</kbd> back to keys`;
  $.noteX.hidden = !d.unsure;
}

function renderBar(): void {
  const r = recs[idx];
  const L = r?.label ?? null;
  const isDirty = dirty(idx);
  let cls: string;
  let txt: string;
  if (L && !isDirty) {
    cls = 'saved';
    txt = `${ICON_CHECK}Saved, ${esc(L.annotation_status)}`;
  } else if (L) {
    cls = 'edited';
    txt = 'Edited, not saved';
  } else {
    cls = 'unsaved';
    txt = 'Not saved';
  }
  let h = `<span class="chip ${cls}">${txt}</span>`;
  if (L && typeof L.note === 'string' && L.note !== '') h += `<span class="snote" title="${esc(L.note)}"><b>Note:</b> ${esc(L.note)}</span>`;
  setHTML($.state, 'state', h);
  $.bUndo.disabled = history.length === 0 || busy;
  $.bDisc.disabled = !isDirty;
  $.bUnsure.classList.toggle('on', cur().unsure);
  const m = bmsgState;
  if (!m) {
    $.bmsg.hidden = true;
    cache.delete('bmsg');
  } else {
    let a = '';
    if (m.action !== undefined) {
      a = `<button type="button" data-act="none" data-slot="${m.action}">Mark ${esc(spanLabel(S.spans[m.action]!))} as none${slotKeys[m.action] ? ' <kbd class="kb">n</kbd>' : ''}</button>`;
    }
    $.bmsg.className = `bmsg ${m.tone}`;
    setHTML($.bmsg, 'bmsg', `<span class="mt">${esc(m.text)}</span>${a}`);
    $.bmsg.hidden = false;
  }
}

function render(): void {
  renderHeader();
  renderSlots();
  renderNote();
  renderHint();
  renderTypes();
  renderNoteRow();
  renderBar();
}

// ---------------------------------------------------------------------------
// Loading / navigation
// ---------------------------------------------------------------------------

function load(i: number): void {
  idx = i;
  cursor = null;
  lastMark = null;
  active = defaultActive(cur());
  $.noteIn.blur();
}

function go(delta: number): void {
  const n = idx + delta;
  if (n < 0) return;
  if (n >= recs.length) {
    if (recs.length < total) bmsg('Still loading more notes\u2026', 'info', undefined, 2500);
    return;
  }
  clearMsgs();
  load(n);
  render();
}

// ---------------------------------------------------------------------------
// Span marking
// ---------------------------------------------------------------------------

function mark(k: number, ta: number, tb: number, keepCursor = false): boolean {
  const d = cur();
  const r = curRec();
  const toks = tkOf(r).toks;
  const f = S.spans[k]!;
  if (!applicable(d, k)) {
    imsg(`${spanLabel(f)} is none for ${d.type}.`);
    return false;
  }
  const lo = toks[Math.min(ta, tb)];
  const hi = toks[Math.max(ta, tb)];
  if (!lo || !hi) return false;
  const s = lo.s;
  const e = hi.e;
  for (let j = 0; j < S.spans.length; j++) {
    if (j === k || !applicable(d, j)) continue;
    const o = d.spans[S.spans[j]!.name];
    if (o && s < o.end && o.start < e) {
      const same = o.start === s && o.end === e;
      const on = spanLabel(S.spans[j]!);
      imsg(`${same ? 'Same text as' : 'Overlaps'} ${on} \u201c${o.text}\u201d. ${on} keeps its span; pick other words for ${spanLabel(f)}.`);
      return false;
    }
  }
  imsgState = null;
  if (bmsgState && bmsgState.tone === 'err') bmsgState = null;
  const span: Span = { text: cpSlice(r.text, s, e), start: s, end: e };
  mutate((x) => {
    x.spans[f.name] = span;
    active = nextOpenAfter(x, k);
  });
  lastMark = { idx, slot: k, anchor: ta };
  if (!keepCursor) cursor = null;
  render();
  return true;
}

function tokenOfSpan(k: number): number {
  const v = cur().spans[S.spans[k]!.name];
  if (!v) return -1;
  return tkOf(curRec()).toks.findIndex((t) => t.s === v.start);
}

function clickToken(i: number, shift: boolean): void {
  let k = active;
  if (shift) {
    const d = cur();
    if (lastMark && lastMark.idx === idx) {
      const v = d.spans[S.spans[lastMark.slot]!.name];
      const t = tkOf(curRec()).toks[lastMark.anchor];
      if (v && t && t.s >= v.start && t.e <= v.end) {
        mark(lastMark.slot, lastMark.anchor, i);
        return;
      }
    }
    const a = tokenOfSpan(k);
    mark(k, a >= 0 ? a : i, i);
    return;
  }
  if (!applicable(cur(), k)) {
    k = firstApplicable(cur());
    active = k;
  }
  mark(k, i, i);
}

function paintDrag(): void {
  $.note.querySelectorAll<HTMLElement>('.tok').forEach((t) => {
    const i = Number(t.dataset.i);
    t.classList.toggle('pre', !!drag && drag.moved && i >= Math.min(drag.a, drag.b) && i <= Math.max(drag.a, drag.b));
  });
}

function tokAt(x: number, y: number): HTMLElement | null {
  const e = document.elementFromPoint(x, y);
  return e ? e.closest<HTMLElement>('.tok') : null;
}

function endDrag(commitIt: boolean): void {
  const dr = drag;
  drag = null;
  if (!dr) return;
  paintDrag();
  if (!commitIt || busy) return;
  if (dr.moved && dr.a !== dr.b) mark(active, dr.a, dr.b);
  else clickToken(dr.a, dr.shift);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function setType(i: number): void {
  const t = S.types[i];
  if (!t || cur().type === t.name) return;
  mutate((d) => {
    d.type = t.name;
    for (const f of S.spans) if (isNullFor(f, t.name)) d.spans[f.name] = undefined;
    active = firstOpen(d, applicable(d, active) ? active : firstApplicable(d));
  });
  imsgState = null;
  if (bmsgState && bmsgState.tone === 'err') bmsgState = null;
  render();
}

function pickSlot(k: number): void {
  const f = S.spans[k];
  if (!f) return;
  const d = cur();
  if (!applicable(d, k)) {
    imsg(`${spanLabel(f)} is none for ${d.type} and cannot be marked.`, 'info');
    return;
  }
  active = k;
  imsgState = null;
  render();
}

function cycleSlot(dir: number): void {
  const d = cur();
  const ok = S.spans.map((_, k) => k).filter((k) => applicable(d, k));
  if (ok.length < 2) {
    if (ok[0] !== undefined) active = ok[0];
    render();
    return;
  }
  const i = ok.indexOf(active);
  active = ok[(i + dir + ok.length) % ok.length]!;
  imsgState = null;
  render();
}

function setNone(k = active): void {
  const f = S.spans[k]!;
  if (!applicable(cur(), k)) {
    imsg(`${spanLabel(f)} is already none for ${cur().type}.`, 'info');
    return;
  }
  mutate((x) => {
    x.spans[f.name] = null;
    active = nextOpenAfter(x, k);
  });
  imsgState = null;
  bmsgState = null;
  render();
}

function clearSlot(k: number): void {
  const f = S.spans[k]!;
  mutate((x) => {
    x.spans[f.name] = undefined;
    delete x.status[f.name];
    active = k;
  });
  imsgState = null;
  render();
}

function toggleStatus(k = active): void {
  const f = S.spans[k]!;
  if (f.statuses.length === 0) {
    const withS = S.spans.filter((x) => x.statuses.length > 0);
    const names = withS.map((x) => `${spanLabel(x)} (press ${slotKeys[S.spans.indexOf(x)] ?? 'its slot key'})`).join(', ');
    imsg(`${spanLabel(f)} has no sure/unsure setting.${names ? ` Only ${names} does.` : ''}`, 'info');
    return;
  }
  if (!applicable(cur(), k)) return;
  const was = cur().status[f.name] ?? f.statuses[0]!;
  const next = f.statuses[(f.statuses.indexOf(was) + 1) % f.statuses.length]!;
  mutate((x) => {
    x.status[f.name] = next;
  });
  imsgState = null;
  render();
  if (next === UNSURE) focusNote();
}

function focusNote(): void {
  renderNoteRow();
  if (!$.noteRow.hidden) {
    $.noteIn.focus();
    const l = $.noteIn.value.length;
    $.noteIn.setSelectionRange(l, l);
  }
}

async function commit(status: string): Promise<void> {
  if (busy) return;
  const i = idx;
  const r = curRec();
  const label = buildLabel(r, status, cur());
  busy = true;
  try {
    const out = await api<{ label?: Label }>('PUT', `${base}/labels/${encodeURIComponent(r.id)}`, { label });
    history.push({ kind: 'save', idx: i, id: r.id, prevLabel: r.label, prevDraft: drafts.has(i) ? clone(drafts.get(i)!) : undefined, active });
    if (history.length > 200) history.shift();
    r.label = out.label ?? label;
    drafts.delete(i);
    recount();
    const last = i >= recs.length - 1;
    $.noteIn.blur();
    clearMsgs();
    load(last ? i : i + 1);
    render();
    const what = status === COMPLETE ? 'complete' : status;
    bmsg(
      last
        ? `Saved \u2713 note ${i + 1} as ${what}.${i + 1 >= total ? ' That was the last note in the queue.' : ''}`
        : `Saved \u2713 note ${i + 1} as ${what}. Now on note ${i + 2}.`,
      'ok',
      undefined,
      4500,
    );
  } catch (e) {
    if (e instanceof Ended) return;
    bmsg(`Not saved: ${errMsg(e)}`, 'err');
  } finally {
    busy = false;
    renderBar();
  }
}

function tryComplete(): void {
  if (busy) return;
  const d = cur();
  if (!completeOk) return void bmsg(`This schema has no "${COMPLETE}" status.`);
  if (!d.type) return void bmsg(`Can\u2019t complete: pick a type first (keys 1-${nTypeKeys()}).`);
  const miss = S.spans.map((_, k) => k).filter((k) => applicable(d, k) && d.spans[S.spans[k]!.name] === undefined);
  if (miss.length > 0) {
    active = miss[0]!;
    const names = miss.map((k) => spanLabel(S.spans[k]!)).join(' and ');
    $.noteIn.blur();
    render();
    bmsg(`Can\u2019t complete: ${names} ${miss.length > 1 ? 'are' : 'is'} not marked. Click a word, or mark ${spanLabel(S.spans[miss[0]!]!)} as none if the note names none.`, 'err', miss[0]);
    return;
  }
  if (unsureSpans(d).length > 0 && d.note.trim() === '') {
    bmsg(NEED_NOTE, 'err');
    focusNote();
    return;
  }
  void commit(COMPLETE);
}

function tryUnsure(): void {
  if (busy) return;
  if (!unsureOk) return void bmsg(`This schema has no "${UNSURE}" status.`);
  const d = cur();
  if (!d.unsure) {
    mutate((x) => {
      x.unsure = true;
    });
    bmsgState = null;
    render();
    focusNote();
    return;
  }
  if (d.note.trim() === '') {
    bmsg(NEED_NOTE, 'err');
    focusNote();
    return;
  }
  void commit(UNSURE);
}

function skip(): void {
  if (busy) return;
  if (!skipStatus) return void bmsg('This schema has no skip status.');
  void commit(skipStatus);
}

function discard(): void {
  if (!dirty(idx)) return;
  pushHist();
  drafts.delete(idx);
  $.noteIn.blur();
  clearMsgs();
  cursor = null;
  active = defaultActive(cur());
  render();
  bmsg('Draft discarded.', 'info', undefined, 3000);
}

async function undo(): Promise<void> {
  if (busy) return;
  const h = history.pop();
  if (!h) return void bmsg('Nothing to undo.', 'info', undefined, 2500);
  $.noteIn.blur();
  if (h.kind === 'draft') {
    if (h.prev) drafts.set(h.idx, h.prev);
    else drafts.delete(h.idx);
  } else {
    const r = recs[h.idx];
    if (!r) return;
    busy = true;
    try {
      if (h.prevLabel) {
        const out = await api<{ label?: Label }>('PUT', `${base}/labels/${encodeURIComponent(h.id)}`, { label: h.prevLabel });
        r.label = out.label ?? h.prevLabel;
      } else {
        await api<unknown>('DELETE', `${base}/labels/${encodeURIComponent(h.id)}`);
        r.label = null;
      }
      recount();
      if (h.prevDraft) drafts.set(h.idx, h.prevDraft);
      else drafts.delete(h.idx);
    } catch (e) {
      history.push(h);
      if (e instanceof Ended) return;
      bmsg(`Undo failed: ${errMsg(e)}`, 'err');
      return;
    } finally {
      busy = false;
      renderBar();
    }
  }
  idx = h.idx;
  active = h.active;
  cursor = null;
  lastMark = null;
  clearMsgs();
  render();
  bmsg('Undone.', 'info', undefined, 2500);
}

function recount(): void {
  labelled = recs.reduce((n, r) => n + (r.label ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Keyboard word cursor (marks spans without a mouse)
// ---------------------------------------------------------------------------

function moveCursor(dir: number, shift: boolean): void {
  const n = tkOf(curRec()).toks.length;
  if (n === 0) return;
  let c = cursor;
  if (!c) c = dir > 0 ? { a: 0, b: 0 } : { a: n - 1, b: n - 1 };
  else if (shift) c = dir > 0 ? { a: c.a, b: Math.min(n - 1, c.b + 1) } : { a: Math.max(0, c.a - 1), b: c.b };
  else {
    const p = dir > 0 ? Math.min(n - 1, c.b + 1) : Math.max(0, c.a - 1);
    c = { a: p, b: p };
  }
  cursor = c;
  imsgState = null;
  renderNote();
  renderHint();
}

function markCursor(): void {
  if (!cursor) return void imsg('Move to a word first with \u2191 / \u2193, then Space.', 'info');
  mark(active, cursor.a, cursor.b, true);
}

// ---------------------------------------------------------------------------
// Note field
// ---------------------------------------------------------------------------

let noteSnap = false;
$.noteIn.addEventListener('focus', () => {
  noteSnap = false;
});
$.noteIn.addEventListener('blur', () => {
  noteSnap = false;
});
$.noteIn.addEventListener('input', () => {
  if (!noteSnap) {
    pushHist();
    noteSnap = true;
  }
  const d = clone(cur());
  d.note = $.noteIn.value;
  drafts.set(idx, d);
  renderBar();
  if (bmsgState && bmsgState.text === NEED_NOTE && d.note.trim() !== '') {
    bmsgState = null;
    renderBar();
  }
});
$.noteX.addEventListener('click', () => {
  mutate((d) => {
    d.unsure = false;
  });
  render();
});

// ---------------------------------------------------------------------------
// Help + tooltip
// ---------------------------------------------------------------------------

function buildHelp(): void {
  const k = (x: string): string => `<kbd>${esc(x)}</kbd>`;
  const keys: Array<[string, string]> = [
    [k(`1-${nTypeKeys()}`), 'pick the type'],
    [S.spans.length > 1 ? `${slotKeys.filter(Boolean).map(k).join(' ')} ${k('Tab')}` : '', 'choose the span slot'],
    [`${k('\u2191')} ${k('\u2193')}`, 'move the word cursor'],
    [`${k('Shift')} + ${k('\u2191')} ${k('\u2193')}`, 'extend the cursor over several words'],
    [k('Space'), 'mark the cursor words into the active slot'],
    [k('n'), 'mark the active slot as none'],
    [k('c'), 'change the active span\u2019s sure / unsure setting (asks for a note)'],
    [k('Enter'), 'Complete and go to the next note'],
    [k('u'), 'Unsure: opens the note field; press u again to save'],
    [k('s'), 'Skip: saves type and spans as none'],
    [k('z'), 'Undo the last change or save'],
    [`${k('\u2190')} ${k('\u2192')}`, 'previous / next note (drafts are kept)'],
    [k('Esc'), 'discard this note\u2019s draft (in the note field: back to keys)'],
    [k('?'), 'this panel'],
  ];
  let h = `<h3>Keys</h3><div class="kl">${keys.filter(([a]) => a !== '').map(([a, t]) => `<span>${a}</span><span>${t}</span>`).join('')}</div>`;
  h += '<p>Mouse: click a word to fill the lit slot, Shift+click or drag for several words. A click on a slot lights it; &times; clears it.</p>';
  h += `<h3>Types</h3><dl>${S.types.map((t, i) => `<dt>${i < 9 ? `${i + 1} ` : ''}${esc(t.name)}</dt><dd>${esc(t.description)}</dd>`).join('')}</dl>`;
  h += `<h3>Spans</h3><dl>${S.spans.map((f) => `<dt>${esc(spanLabel(f))}</dt><dd>${esc(f.description)}</dd>`).join('')}</dl>`;
  h += `<h3>Statuses</h3><dl>${S.statuses.map((s) => `<dt>${esc(s.name)}</dt><dd>${esc(s.description)}</dd>`).join('')}</dl>`;
  $.helpBody.innerHTML = h;
}

function setHelp(open: boolean): void {
  $.help.hidden = !open;
  $.helpBtn.setAttribute('aria-expanded', String(open));
  hideTip();
}

let tipT = 0;
function showTip(btn: HTMLElement): void {
  const i = Number(btn.dataset.i);
  const t = S.types[i];
  if (!t || t.description === '') return;
  clearTimeout(tipT);
  tipT = window.setTimeout(() => {
    $.tip.innerHTML = `<b>${i < 9 ? `${i + 1} ` : ''}${esc(t.name)}</b>${esc(t.description)}`;
    $.tip.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = $.tip.offsetWidth;
    const h = $.tip.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    let top = r.top - h - 8;
    if (top < 64) top = Math.min(innerHeight - h - 8, r.bottom + 8);
    $.tip.style.left = `${left}px`;
    $.tip.style.top = `${top}px`;
  }, 200);
}
function hideTip(): void {
  clearTimeout(tipT);
  $.tip.hidden = true;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$.note.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !ready || busy) return;
  const t = (e.target as Element).closest<HTMLElement>('.tok');
  if (!t) return;
  hideTip();
  const i = Number(t.dataset.i);
  drag = { a: i, b: i, shift: e.shiftKey, moved: false };
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const t = tokAt(e.clientX, e.clientY);
  if (!t) return;
  const i = Number(t.dataset.i);
  if (i !== drag.b) {
    drag.b = i;
    if (i !== drag.a) drag.moved = true;
    paintDrag();
  }
});
document.addEventListener('pointerup', () => endDrag(true));
document.addEventListener('pointercancel', () => endDrag(false));

$.types.addEventListener('mouseover', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.type');
  if (b) showTip(b);
});
$.types.addEventListener('mouseout', (e) => {
  const rt = e.relatedTarget as Element | null;
  if (!rt || !rt.closest || !rt.closest('.type')) hideTip();
});
$.types.addEventListener('focusin', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.type');
  if (b) showTip(b);
});
$.types.addEventListener('focusout', hideTip);
$.types.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('.type');
  if (b && ready && !busy) {
    hideTip();
    setType(Number(b.dataset.i));
  }
});

function onAct(e: Event): void {
  const b = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!b || !ready) return;
  const a = b.dataset.act;
  const slot = b.dataset.slot !== undefined ? Number(b.dataset.slot) : undefined;
  if (busy && a !== 'pick') return;
  switch (a) {
    case 'pick':
      if (slot !== undefined) pickSlot(slot);
      break;
    case 'none':
      if (slot !== undefined) {
        if (applicable(cur(), slot)) active = slot;
        setNone(slot);
      } else setNone();
      break;
    case 'clear':
      if (slot !== undefined) clearSlot(slot);
      break;
    case 'toggle':
      toggleStatus(slot);
      break;
    case 'prev':
      go(-1);
      break;
    case 'next':
      go(1);
      break;
    case 'complete':
      tryComplete();
      break;
    case 'unsure':
      tryUnsure();
      break;
    case 'skip':
      skip();
      break;
    case 'undo':
      void undo();
      break;
    case 'discard':
      discard();
      break;
  }
  if (a !== 'pick') b.blur();
}
$.slots.addEventListener('click', onAct);
$.foot.addEventListener('click', onAct);
$.helpBtn.addEventListener('click', () => setHelp(Boolean($.help.hidden)));
el('helpClose').addEventListener('click', () => setHelp(false));

document.addEventListener('keydown', () => {
  touched = true;
}, true);
document.addEventListener('pointerdown', () => {
  touched = true;
}, true);

// ONLY: 1-9 (types), the slot keys, Tab, n, c, Enter, u, s, z, arrows, Space (word cursor), ?, Esc
document.addEventListener('keydown', (e) => {
  if (!ready || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const k = e.key;
  if (e.target === $.noteIn) {
    if (k === 'Enter') {
      e.preventDefault();
      if (cur().unsure) tryUnsure();
      else tryComplete();
    } else if (k === 'Escape') {
      e.preventDefault();
      $.noteIn.blur();
    } else if (k === 'Tab') e.preventDefault();
    return;
  }
  if (!$.help.hidden) {
    if (k === 'Escape' || k === '?') {
      e.preventDefault();
      setHelp(false);
    }
    return;
  }
  if (/^[1-9]$/.test(k)) {
    e.preventDefault();
    if (!busy && Number(k) <= S.types.length) setType(Number(k) - 1);
    return;
  }
  const lk = k.length === 1 ? k.toLowerCase() : k;
  const slot = lk.length === 1 ? slotKeys.indexOf(lk) : -1;
  if (slot >= 0) {
    e.preventDefault();
    if (!busy) pickSlot(slot);
    return;
  }
  switch (lk) {
    case 'Tab':
      e.preventDefault();
      if (!busy) cycleSlot(e.shiftKey ? -1 : 1);
      break;
    case 'n':
      e.preventDefault();
      if (!busy) setNone();
      break;
    case 'c':
      e.preventDefault();
      if (!busy) toggleStatus();
      break;
    case 'Enter':
      e.preventDefault();
      if (!e.repeat) tryComplete();
      break;
    case 'u':
      e.preventDefault();
      if (!e.repeat) tryUnsure();
      break;
    case 's':
      e.preventDefault();
      if (!e.repeat) skip();
      break;
    case 'z':
      e.preventDefault();
      if (!e.repeat) void undo();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (!busy) go(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (!busy) go(1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveCursor(1, e.shiftKey);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveCursor(-1, e.shiftKey);
      break;
    case ' ':
      e.preventDefault();
      if (!busy) markCursor();
      break;
    case '?':
      e.preventDefault();
      setHelp(true);
      break;
    case 'Escape':
      e.preventDefault();
      if (!busy) discard();
      break;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fatal(message: string): void {
  $.fatal.textContent = `${message} `;
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = '\u2190 your projects';
  $.fatal.appendChild(a);
  $.fatal.hidden = false;
  $.stage.hidden = true;
  $.foot.hidden = true;
}

function setLoadNote(text: string, err = false): void {
  $.loadNote.hidden = text === '';
  $.loadNote.textContent = text;
  $.loadNote.classList.toggle('err', err);
}

function appendItems(items: ItemRow[]): void {
  let firstUnlabelled = -1;
  for (const it of items) {
    if (byId.has(it.id)) continue; // never keep a record twice
    const i = recs.push({ id: it.id, text: it.text, label: it.label ?? null, tk: null }) - 1;
    byId.add(it.id);
    if (firstUnlabelled < 0 && !it.label) firstUnlabelled = i;
  }
  recount();
  if (ready && autoPlace && !touched && firstUnlabelled >= 0) {
    autoPlace = false;
    load(firstUnlabelled);
    render();
  } else if (ready) {
    renderHeader();
  }
}

async function loadRest(): Promise<void> {
  let failures = 0;
  while (recs.length < total) {
    setLoadNote(`loading ${recs.length} / ${total}\u2026`);
    try {
      const page = await api<ItemsPage>('GET', `${base}/items?offset=${recs.length}&limit=${PAGE}`);
      if (page.items.length === 0) break;
      const before = recs.length;
      total = page.total;
      appendItems(page.items);
      if (recs.length === before) break; // nothing new: the server and we disagree, stop
      failures = 0;
    } catch (e) {
      if (e instanceof Ended) return;
      if (++failures >= 3) {
        setLoadNote(`could not load the rest of the queue (${errMsg(e)}) \u2014 reload to retry`, true);
        return;
      }
      await sleep(1500 * failures);
    }
  }
  total = recs.length;
  setLoadNote('');
  renderHeader();
}

function assignSlotKeys(): void {
  const used = new Set<string>(RESERVED_KEYS);
  slotKeys = S.spans.map((f) => {
    for (const ch of f.name.toLowerCase()) {
      if (/^[a-z]$/.test(ch) && !used.has(ch)) {
        used.add(ch);
        return ch;
      }
    }
    return '';
  });
}

async function boot(): Promise<void> {
  const parts = location.pathname.split('/').filter(Boolean);
  let slug = parts[1] ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw segment; the API will answer 404
  }
  base = `/api/projects/${encodeURIComponent(slug)}`;

  try {
    project = (await api<{ project: Project }>('GET', base)).project;
  } catch (e) {
    if (e instanceof Ended) return;
    if (e instanceof ApiError && e.status === 404) fatal('Project not found or not assigned.');
    else fatal(`Could not load the project: ${errMsg(e)}`);
    return;
  }
  try {
    S = parseSchema(project.schema);
  } catch (e) {
    fatal(`This project's schema is not usable: ${e instanceof SchemaError ? e.message : errMsg(e)}`);
    return;
  }
  document.title = `${project.name} \u00b7 quet`;
  $.projName.textContent = project.name;

  let first: ItemsPage;
  try {
    first = await api<ItemsPage>('GET', `${base}/items?offset=0&limit=${PAGE}`);
  } catch (e) {
    if (e instanceof Ended) return;
    fatal(`Could not load the queue: ${errMsg(e)}`);
    return;
  }
  total = first.total;
  appendItems(first.items);
  if (recs.length === 0) {
    fatal('This project has no notes yet.');
    return;
  }

  assignSlotKeys();
  completeOk = S.statuses.some((s) => s.name === COMPLETE);
  unsureOk = S.statuses.some((s) => s.name === UNSURE);
  skipStatus = S.null_label_statuses.find((n) => S.statuses.some((s) => s.name === n)) ?? null;
  document.querySelector<HTMLElement>('[data-act="complete"]')!.hidden = !completeOk;
  $.bUnsure.hidden = !unsureOk;
  document.querySelector<HTMLElement>('[data-act="skip"]')!.hidden = skipStatus === null;
  buildHelp();

  const open = recs.findIndex((r) => !r.label);
  autoPlace = open < 0 && recs.length < total;
  load(Math.max(0, open));
  $.stage.hidden = false;
  $.foot.hidden = false;
  ready = true;
  render();
  void loadRest();
}

void boot();
