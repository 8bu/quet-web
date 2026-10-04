// Collaborator labelling screen (/p/:slug): focus card + queue drawer.
// Offsets are Unicode code points (end exclusive); every conversion goes through src/shared/schema.ts.

import type { Label, Schema, Span, SpanField } from '../shared/schema';
import { SchemaError, cpSlice, isNullFor, normalizeLabel, parseSchema, validateProposal, wordRanges } from '../shared/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Project {
  slug: string;
  name: string;
  schema: unknown;
  show_proposals: boolean;
  items: number;
}

interface ItemRow {
  id: string;
  position: number;
  text: string;
  proposal: Record<string, unknown> | null;
  label: Label | null;
}

interface ItemsPage {
  items: ItemRow[];
  total: number;
}

interface Word { start: number; end: number }

/** Lazily computed per-record view of the text: one entry per code point. */
interface RecView { chars: string[]; words: Word[] }

interface Rec {
  id: string;
  position: number;
  text: string;
  label: Label | null; // my label only
  proposal: Record<string, unknown> | null;
  v: RecView | null;
  row: HTMLButtonElement | null;
}

/** Unsaved edits. A span absent from `spans` is "not marked yet"; `null` means "there is none". */
interface Draft {
  type: string | null;
  spans: Map<string, Span | null>;
  spanStatus: Map<string, string>;
}

interface SpanSel { a: number; h: number }

interface State {
  i: number;
  draft: Draft;
  sel: SpanSel | null; // keyboard span mode
  pend: { lo: number; hi: number } | null; // live mouse selection (inclusive code-point indices)
  active: number;
  snap: boolean;
  dirty: boolean;
  advFrom: number | undefined;
  touched: boolean;
  autoPlace: boolean;
}

interface PropInfo {
  P: Record<string, unknown>;
  error: string | null;
  draft: Draft | null;
  label: Label | null;
  matches: boolean;
}

class Ended extends Error {}
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// DOM + small helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function on(node: HTMLElement, fn: () => void): void {
  node.addEventListener('click', () => {
    if (!busy) fn();
  });
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const glyph = (name: string): string => (({ complete: '\u2713', uncertain: '?', skipped: '\u2013' }) as Record<string, string>)[name] ?? name.charAt(0);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// unicode.IsSpace in Go (the same test the shared validator uses for padded spans)
const SPACE_RE = /^[\t\n\v\f\r \u0085\u00a0\p{Z}]$/u;
const isSpaceCh = (ch: string | undefined): boolean => ch !== undefined && SPACE_RE.test(ch);

const PAGE = 200;
const KEYCAP: Record<string, string> = { complete: '\u23ce', uncertain: 'u', skipped: 's' };

const $ = {
  projName: el<HTMLElement>('projName'),
  progTxt: el<HTMLElement>('progTxt'),
  barDone: el<HTMLElement>('barDone'),
  counts: el<HTMLElement>('counts'),
  loadNote: el<HTMLElement>('loadNote'),
  fatal: el<HTMLElement>('fatal'),
  stage: el<HTMLElement>('stage'),
  drawer: el<HTMLElement>('drawer'),
  drawerCount: el<HTMLElement>('drawerCount'),
  queueList: el<HTMLElement>('queueList'),
  recMeta: el<HTMLElement>('recMeta'),
  savedChip: el<HTMLElement>('savedChip'),
  text: el<HTMLElement>('text'),
  spans: el<HTMLElement>('spans'),
  nullTxt: el<HTMLElement>('nullTxt'),
  snapTxt: el<HTMLElement>('snapTxt'),
  bField: el<HTMLElement>('bField'),
  bStatus: el<HTMLElement>('bStatus'),
  hint: el<HTMLElement>('hint'),
  proposal: el<HTMLElement>('proposal'),
  typeRange: el<HTMLElement>('typeRange'),
  types: el<HTMLElement>('types'),
  statuses: el<HTMLElement>('statuses'),
  draft: el<HTMLElement>('draft'),
  dragtip: el<HTMLElement>('dragtip'),
  toast: el<HTMLElement>('toast'),
  help: el<HTMLElement>('help'),
  helpKeys: el<HTMLElement>('helpKeys'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let project: Project;
let S: Schema;
let base = '';
let recs: Rec[] = [];
let byId = new Map<string, number>();
let total = 0;
let ready = false;
let busy = false;
let helpOpen = false;
let drawerOpen = false;
let toastTimer = 0;
let hintMsg: { text: string; err: boolean } | null = null;
let curRow: HTMLElement | null = null;
const undoStack: Array<{ id: string; prev: Label | null }> = [];
const tally = { labelled: 0, by: new Map<string, number>() };

const st: State = {
  i: 0,
  draft: { type: null, spans: new Map(), spanStatus: new Map() },
  sel: null,
  pend: null,
  active: 0,
  snap: true,
  dirty: false,
  advFrom: undefined,
  touched: false,
  autoPlace: false,
};

const cur = (): Rec => {
  const r = recs[st.i];
  if (!r) throw new Error('no current record');
  return r;
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
// Records: offsets are code points
// ---------------------------------------------------------------------------

function view(r: Rec): RecView {
  if (!r.v) r.v = { chars: Array.from(r.text), words: wordRanges(r.text) };
  return r.v;
}

const wordIdx = (v: RecView, i: number): number => v.words.findIndex((w) => i >= w.start && i < w.end);

/** Inclusive code-point indices -> span, trimmed of surrounding whitespace; null when only whitespace. */
function mkSpan(r: Rec, lo: number, hi: number): Span | null {
  const chars = view(r).chars;
  while (lo <= hi && isSpaceCh(chars[lo])) lo++;
  while (hi >= lo && isSpaceCh(chars[hi])) hi--;
  return hi < lo ? null : { text: cpSlice(r.text, lo, hi + 1), start: lo, end: hi + 1 };
}

const fmtSpan = (s: Span | null | undefined): string => (s == null ? 'null' : `"${s.text}" [${s.start},${s.end})`);

function asSpan(v: unknown): Span | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.start === 'number' && typeof o.end === 'number'
    ? { text: o.text, start: o.start, end: o.end }
    : null;
}

/** Looser formatter for proposal members, which may be malformed. */
function fmtLoose(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const s = asSpan(v);
  return s ? fmtSpan(s) : JSON.stringify(v);
}

function snapRange(v: RecView, a: number, h: number): [number, number] {
  let lo = Math.min(a, h);
  let hi = Math.max(a, h);
  let w = wordIdx(v, lo);
  if (w >= 0) lo = v.words[w]!.start;
  w = wordIdx(v, hi);
  if (w >= 0) hi = v.words[w]!.end - 1;
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Drafts and labels
// ---------------------------------------------------------------------------

const emptyDraft = (): Draft => ({ type: null, spans: new Map(), spanStatus: new Map() });
const fieldName = (f: SpanField): string => f.name;
const nTypeKeys = (): number => Math.min(9, S.types.length);

function draftFromLabel(L: Label | null): Draft {
  const d = emptyDraft();
  if (!L) return d;
  d.type = typeof L.type === 'string' ? L.type : null;
  if (!S.null_label_statuses.includes(L.annotation_status)) {
    for (const sp of S.spans) d.spans.set(sp.name, asSpan(L[sp.name]));
  }
  const ss = L.span_status;
  if (ss && typeof ss === 'object') {
    for (const [k, val] of Object.entries(ss)) if (typeof val === 'string') d.spanStatus.set(k, val);
  }
  return d;
}

/** The wire label for `status` + `d`, in schema key order. */
function buildLabel(r: Rec, status: string, d: Draft, note?: string): Label {
  const raw: Label = { id: r.id, annotation_status: status, type: d.type };
  const kept = note ?? r.label?.note;
  if (typeof kept === 'string' && kept !== '') raw.note = kept;
  const ss: Record<string, string> = {};
  for (const sp of S.spans) {
    const locked = isNullFor(sp, d.type);
    raw[sp.name] = locked ? null : (d.spans.get(sp.name) ?? null);
    const first = sp.statuses[0];
    if (first !== undefined && !locked) ss[sp.name] = d.spanStatus.get(sp.name) ?? first;
  }
  if (Object.keys(ss).length > 0) raw.span_status = ss;
  return normalizeLabel(S, raw);
}

const firstOpenField = (type: string | null): number => {
  const k = S.spans.findIndex((sp) => !isNullFor(sp, type));
  return k >= 0 ? k : 0;
};

function loadDraft(): void {
  st.draft = draftFromLabel(cur().label);
  st.sel = null;
  st.pend = null;
  st.dirty = false;
  st.advFrom = undefined;
  st.active = firstOpenField(st.draft.type);
  hintMsg = null;
}

function recount(): void {
  tally.labelled = 0;
  tally.by.clear();
  for (const s of S.statuses) tally.by.set(s.name, 0);
  for (const r of recs) {
    if (!r.label) continue;
    tally.labelled++;
    tally.by.set(r.label.annotation_status, (tally.by.get(r.label.annotation_status) ?? 0) + 1);
  }
}

function describeField(f: SpanField): string {
  const d = st.draft;
  if (isNullFor(f, d.type)) return `null \u2014 ${d.type} has no ${f.name}`;
  const v = d.spans.get(f.name);
  let t = d.spans.has(f.name) ? fmtSpan(v) : 'not marked yet';
  if (f.statuses.length > 0) {
    const s = d.spanStatus.get(f.name);
    t += ` \u00b7 ${s ?? f.statuses[0]}${s ? '' : ' (default)'}`;
  }
  return t;
}

function firstUnmarked(d: Draft): SpanField | undefined {
  return S.spans.find((sp) => !isNullFor(sp, d.type) && !d.spans.has(sp.name));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function say(msg: string, kind = ''): void {
  $.toast.textContent = msg;
  $.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    $.toast.className = 'toast';
  }, 4200);
}

function setHint(text: string, err = true): void {
  hintMsg = { text, err };
  renderHint();
}

/** Error toast plus the same text in the hint line. */
function refuse(text: string): void {
  say(text, 'err');
  setHint(text);
}

function defaultHint(): string {
  const d = st.draft;
  if (st.sel) return 'enter accept \u00b7 esc cancel \u00b7 \u2190/\u2192 move \u00b7 shift+\u2190/\u2192 extend \u00b7 w/b words';
  if (!st.dirty && cur().label) return 'saved \u00b7 j next \u00b7 ] next unlabelled \u00b7 change anything and save again to revise';
  if (d.type == null) return `pick a type: 1\u2013${nTypeKeys()} \u00b7 or s to skip`;
  const f = firstUnmarked(d);
  if (f) return `mark the ${fieldName(f)}: click or drag the text, or x \u00b7 n if there is none`;
  return 'press enter to save as complete \u00b7 u uncertain \u00b7 s skip';
}

function renderHint(): void {
  $.hint.textContent = hintMsg ? hintMsg.text : defaultHint();
  $.hint.classList.toggle('err', hintMsg?.err === true);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pendRange(): { lo: number; hi: number } | null {
  if (st.pend) return st.pend;
  const s = st.sel;
  return s ? { lo: Math.min(s.a, s.h), hi: Math.max(s.a, s.h) } : null;
}

function pendReadout(): string | null {
  const p = pendRange();
  if (!p) return null;
  const sp = mkSpan(cur(), p.lo, p.hi);
  return sp ? fmtSpan(sp) : '(only spaces)';
}

function renderText(): void {
  const r = cur();
  const box = $.text;
  if (box.dataset.rid !== r.id) {
    box.textContent = '';
    box.dataset.rid = r.id;
    const frag = document.createDocumentFragment();
    view(r).chars.forEach((ch, i) => {
      const s = mk('span', 'c', ch);
      s.dataset.i = String(i);
      frag.appendChild(s);
    });
    box.appendChild(frag);
  }
  paintText();
}

function paintText(): void {
  const r = cur();
  const v = view(r);
  const n = v.chars.length;
  const kids = $.text.children;
  const cov = new Array<number>(n).fill(-1);
  const act = st.active;
  const d = st.draft;
  S.spans.forEach((f, fi) => {
    const sp = d.spans.get(f.name);
    if (sp && fi !== act) for (let i = sp.start; i < sp.end && i < n; i++) cov[i] = fi;
  });
  const sa = S.spans[act] ? d.spans.get(S.spans[act]!.name) : null;
  if (sa) for (let i = sa.start; i < sa.end && i < n; i++) cov[i] = act;
  const p = pendRange();
  for (let i = 0; i < n; i++) {
    const node = kids[i];
    if (!node) continue;
    let cls = 'c' + (isSpaceCh(v.chars[i]) ? ' sp' : '');
    const fi = cov[i] ?? -1;
    if (fi >= 0) {
      const sp = d.spans.get(S.spans[fi]!.name)!;
      cls += ` h h${fi % 6}` + (fi === act ? ' act' : '');
      if (sp.start === i) cls += ' fs';
      if (sp.end - 1 === i) cls += ' fe';
    }
    if (p && i >= p.lo && i <= p.hi) {
      cls += ' pend';
      if (i === p.lo) cls += ' ps';
      if (i === p.hi) cls += ' pe';
    }
    if (node.className !== cls) node.className = cls;
  }
}

let spanRows: Array<{ row: HTMLButtonElement; val: HTMLElement; f: SpanField }> = [];

function buildSpans(): void {
  $.spans.textContent = '';
  spanRows = [];
  S.spans.forEach((f, fi) => {
    const locked = isNullFor(f, st.draft.type);
    const row = mk('button', `srow h${fi % 6}` + (fi === st.active ? ' act' : '') + (locked ? ' locked' : ''));
    row.type = 'button';
    row.tabIndex = -1;
    row.appendChild(mk('i', 'sw'));
    row.appendChild(mk('span', 'sn', S.implicit_target ? 'Target' : cap(f.name)));
    if (f.description) {
      const sd = mk('span', 'sd', f.description);
      sd.title = f.description;
      row.appendChild(sd);
    }
    const val = mk('span', 'sv');
    row.appendChild(val);
    on(row, () => {
      if (st.active === fi) return;
      st.active = fi;
      say(`writing to: ${f.name}`);
      render();
    });
    $.spans.appendChild(row);
    spanRows.push({ row, val, f });
  });
}

function paintSpans(): void {
  const pr = pendReadout();
  spanRows.forEach(({ val, f }, fi) => {
    if (fi === st.active && pr) {
      val.textContent = pr;
      val.className = 'sv pending';
    } else {
      val.textContent = describeField(f);
      val.className = 'sv' + (st.draft.spans.get(f.name) ? ' set' : '');
    }
  });
}

function paint(): void {
  paintText();
  paintSpans();
}

function renderCounts(): void {
  $.counts.textContent = '';
  for (const s of S.statuses) {
    const c = mk('span', `chip s-${s.name}`, `${glyph(s.name)} ${s.name} ${tally.by.get(s.name) ?? 0}`);
    c.title = s.description;
    $.counts.appendChild(c);
  }
  $.counts.appendChild(mk('span', 'chip s-left', `${total - tally.labelled} left`));
}

function renderHeader(): void {
  $.progTxt.textContent = `${st.i + 1} / ${total}`;
  $.barDone.style.width = `${total > 0 ? (100 * tally.labelled) / total : 0}%`;
  $.drawerCount.textContent = `${tally.labelled} of ${total} labelled`;
  renderCounts();
}

function renderTypes(): void {
  const box = $.types;
  box.textContent = '';
  S.types.forEach((t, i) => {
    const b = mk('button', 'trow' + (st.draft.type === t.name ? ' sel' : ''));
    b.type = 'button';
    b.tabIndex = -1;
    b.title = t.description;
    b.appendChild(mk('kbd', undefined, i < 9 ? String(i + 1) : '\u00b7'));
    const body = mk('span', 'tb');
    body.appendChild(mk('span', 'tn', t.name));
    if (t.description) body.appendChild(mk('span', 'td', t.description));
    b.appendChild(body);
    for (const sp of S.spans) {
      if (sp.null_for_types.includes(t.name)) b.appendChild(mk('span', 'tag', `no ${sp.name}`));
    }
    on(b, () => setType(i));
    box.appendChild(b);
  });
}

function renderStatuses(): void {
  const box = $.statuses;
  const L = cur().label;
  box.textContent = '';
  for (const s of S.statuses) {
    const b = mk('button', `sbtn st-${s.name}` + (L && L.annotation_status === s.name ? ' saved' : ''));
    b.type = 'button';
    b.tabIndex = -1;
    b.title = s.description;
    b.appendChild(mk('span', 'sg', glyph(s.name)));
    b.appendChild(mk('span', 'sn2', s.name));
    const k = KEYCAP[s.name];
    if (k) b.appendChild(mk('kbd', undefined, k));
    on(b, () => void save(s.name));
    box.appendChild(b);
  }
}

function renderDraftLine(): void {
  const d = st.draft;
  const box = $.draft;
  box.textContent = '';
  box.appendChild(document.createTextNode('Draft: '));
  box.appendChild(mk('b', undefined, d.type ?? 'no type yet'));
  const parts = S.spans.map((f) => {
    if (isNullFor(f, d.type)) return `no ${f.name}`;
    const v = d.spans.get(f.name);
    return v ? v.text : d.spans.has(f.name) ? `no ${f.name}` : `${f.name} not marked`;
  });
  box.appendChild(document.createTextNode(` \u00b7 ${parts.join(' \u00b7 ')}`));
}

// ---- proposals ----

function proposalDraft(P: Record<string, unknown>): Draft {
  const d = emptyDraft();
  const status = String(P.annotation_status);
  if (S.null_label_statuses.includes(status)) return d;
  d.type = typeof P.type === 'string' ? P.type : null;
  for (const sp of S.spans) d.spans.set(sp.name, isNullFor(sp, d.type) ? null : asSpan(P[sp.name]));
  const ss = P.span_status;
  if (ss && typeof ss === 'object') {
    for (const [k, val] of Object.entries(ss as Record<string, unknown>)) {
      const sp = S.spans.find((x) => x.name === k);
      if (sp && typeof val === 'string' && !isNullFor(sp, d.type)) d.spanStatus.set(k, val);
    }
  }
  return d;
}

const sameSpan = (a: Span | null | undefined, b: Span | null | undefined): boolean =>
  a == null || b == null ? a == null && b == null : a.start === b.start && a.end === b.end;

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.type !== b.type) return false;
  for (const sp of S.spans) {
    if (isNullFor(sp, a.type)) continue;
    if (a.spans.has(sp.name) !== b.spans.has(sp.name)) return false;
    if (!sameSpan(a.spans.get(sp.name), b.spans.get(sp.name))) return false;
    const first = sp.statuses[0];
    if (first !== undefined && (a.spanStatus.get(sp.name) ?? first) !== (b.spanStatus.get(sp.name) ?? first)) return false;
  }
  return true;
}

function propInfo(r: Rec): PropInfo | null {
  if (!project.show_proposals || !r.proposal) return null;
  const P = r.proposal;
  const verdict = validateProposal(S, r.text, P);
  if (!verdict.ok) return { P, error: verdict.error, draft: null, label: null, matches: false };
  const draft = proposalDraft(P);
  const label = buildLabel(r, String(P.annotation_status), draft, typeof P.note === 'string' && P.note !== '' ? P.note : undefined);
  const matches = st.dirty ? sameDraft(draft, st.draft) : r.label !== null && JSON.stringify(label) === JSON.stringify(r.label);
  return { P, error: null, draft, label, matches };
}

function renderProposal(): void {
  const box = $.proposal;
  box.textContent = '';
  const info = propInfo(cur());
  box.hidden = !info;
  if (!info) return;
  const P = info.P;
  const head = mk('div', 'ph');
  head.appendChild(mk('span', 'pt', 'Proposal \u2014 not accepted'));
  head.appendChild(mk('span', 'pn', 'advisory \u00b7 nothing is saved unless you accept'));
  box.appendChild(head);

  const status = String(P.annotation_status);
  const rows: Array<[string, string]> = [
    ['Status', `${glyph(status)} ${status}`],
    ['Type', P.type == null ? 'null' : String(P.type)],
  ];
  const pss = P.span_status && typeof P.span_status === 'object' ? (P.span_status as Record<string, unknown>) : {};
  for (const sp of S.spans) {
    let t = fmtLoose(P[sp.name]);
    const ss = pss[sp.name];
    if (typeof ss === 'string' && ss) t += ` \u00b7 ${ss}`;
    rows.push([S.implicit_target ? 'Target' : cap(sp.name), t]);
  }
  const conf = typeof P.confidence === 'number' ? P.confidence : null;
  rows.push(['Confidence', conf === null ? '-' : conf.toFixed(2)]);
  if (typeof P.reason === 'string' && P.reason) rows.push(['Reason', P.reason]);
  if (typeof P.note === 'string' && P.note) rows.push(['Note', P.note]);

  const dl = mk('dl', 'pgrid');
  for (const [k, val] of rows) {
    dl.appendChild(mk('dt', undefined, k));
    const dd = mk('dd', undefined, val);
    if (k === 'Confidence' && conf !== null) {
      const bar = mk('span', 'cbar');
      const fill = mk('i');
      fill.style.width = `${Math.max(0, Math.min(1, conf)) * 100}%`;
      bar.appendChild(fill);
      dd.appendChild(bar);
    }
    dl.appendChild(dd);
  }
  box.appendChild(dl);
  if (info.error) box.appendChild(mk('div', 'pbad', `\u26a0 invalid: ${info.error}`));
  else if (info.matches) box.appendChild(mk('div', 'pok', '\u2713 matches current'));

  const act = mk('div', 'pact');
  const a = mk('button');
  const l = mk('button');
  a.type = 'button';
  l.type = 'button';
  a.tabIndex = -1;
  l.tabIndex = -1;
  a.disabled = info.error !== null;
  a.append('Accept ', mk('kbd', undefined, 'p'));
  l.append('Load into draft ', mk('kbd', undefined, 'P'));
  on(a, () => void acceptProposal());
  on(l, loadProposal);
  act.append(a, l);
  box.appendChild(act);
}

// ---- queue drawer rows ----

function rowSummary(L: Label): string {
  if (S.null_label_statuses.includes(L.annotation_status)) return L.annotation_status;
  const parts: string[] = [typeof L.type === 'string' ? L.type : L.annotation_status === 'complete' ? '\u2014' : L.annotation_status];
  for (const sp of S.spans) {
    const s = asSpan(L[sp.name]);
    if (s) parts.push(`\u201c${s.text}\u201d`);
  }
  return parts.join(' \u00b7 ');
}

function paintRow(r: Rec): void {
  const b = r.row;
  if (!b) return;
  const L = r.label;
  b.className = 'qrow' + (L ? ` s-${L.annotation_status}` : '') + (b === curRow ? ' cur' : '');
  const g = b.querySelector('.qg');
  const l = b.querySelector('.ql');
  if (g) g.textContent = L ? glyph(L.annotation_status) : '\u00b7';
  if (l) l.textContent = L ? rowSummary(L) : '';
}

function buildRow(r: Rec, i: number): HTMLButtonElement {
  const b = mk('button', 'qrow');
  b.type = 'button';
  b.tabIndex = -1;
  b.dataset.i = String(i);
  b.appendChild(mk('span', 'qn', String(i + 1)));
  b.appendChild(mk('span', 'qg'));
  const body = mk('span', 'qb');
  body.appendChild(mk('span', 'qt', r.text));
  body.appendChild(mk('span', 'ql'));
  b.appendChild(body);
  r.row = b;
  paintRow(r);
  return b;
}

function markCurrentRow(): void {
  const r = recs[st.i];
  if (curRow && curRow !== r?.row) {
    curRow.classList.remove('cur');
  }
  if (r?.row) {
    r.row.classList.add('cur');
    curRow = r.row;
    if (drawerOpen) r.row.scrollIntoView({ block: 'nearest' });
  }
}

// ---- whole screen ----

function render(): void {
  const r = cur();
  const L = r.label;
  renderHeader();
  $.recMeta.textContent = `Record ${st.i + 1} \u00b7 ${r.id}`;
  $.savedChip.className = 'saved' + (L ? ` s-${L.annotation_status}` : '');
  $.savedChip.textContent = L
    ? `Saved ${glyph(L.annotation_status)} ${L.annotation_status}` + (st.dirty ? ' \u00b7 edited, not saved' : '')
    : st.dirty
      ? 'Draft \u00b7 not saved'
      : 'Not labelled yet';
  renderText();
  buildSpans();
  paintSpans();
  const f = S.spans[st.active];
  $.nullTxt.textContent = S.spans.length > 1 && f ? `no ${f.name}` : S.implicit_target ? 'no target' : `no ${f?.name ?? 'span'}`;
  $.snapTxt.textContent = `snap: ${st.snap ? 'words' : 'characters'}`;
  renderTypes();
  renderStatuses();
  renderDraftLine();
  renderProposal();
  renderHint();
  markCurrentRow();
}

// ---------------------------------------------------------------------------
// Draft edits
// ---------------------------------------------------------------------------

function lockedMsg(f: SpanField): string {
  return `${f.name} must be null for ${st.draft.type}` + (S.spans.length > 1 ? ' \u2014 tab switches field' : ' \u2014 pick another type first');
}

function setType(n: number): void {
  const t = S.types[n];
  if (!t) {
    say(`no type ${n + 1} \u2014 this schema has ${S.types.length}`, 'err');
    return;
  }
  const d = st.draft;
  const old = d.type;
  for (const sp of S.spans) {
    const was = isNullFor(sp, old);
    const now = isNullFor(sp, t.name);
    if (now) {
      d.spans.set(sp.name, null);
      d.spanStatus.delete(sp.name);
    } else if (was) {
      d.spans.delete(sp.name);
    }
  }
  d.type = t.name;
  st.dirty = true;
  st.sel = null;
  hintMsg = null;
  const a = S.spans[st.active];
  if (a && isNullFor(a, t.name)) st.active = firstOpenField(t.name);
  render();
}

function advanceActive(): void {
  const n = S.spans.length;
  if (n < 2) return;
  for (let k = 1; k < n; k++) {
    const j = (st.active + k) % n;
    const f = S.spans[j]!;
    if (!isNullFor(f, st.draft.type) && !st.draft.spans.has(f.name)) {
      st.advFrom = st.active;
      st.active = j;
      return;
    }
  }
}

function setSpan(sp: Span): boolean {
  const f = S.spans[st.active]!;
  if (isNullFor(f, st.draft.type)) {
    say(lockedMsg(f), 'err');
    render();
    return false;
  }
  st.draft.spans.set(f.name, sp);
  st.dirty = true;
  hintMsg = null;
  say(`${S.implicit_target ? 'Target' : cap(f.name)} ${fmtSpan(sp)}`, 'ok');
  advanceActive();
  render();
  return true;
}

function nullField(): void {
  const f = S.spans[st.active]!;
  st.sel = null;
  if (isNullFor(f, st.draft.type)) {
    say(`${f.name} is already null for ${st.draft.type}`, 'err');
    render();
    return;
  }
  st.draft.spans.set(f.name, null);
  st.dirty = true;
  hintMsg = null;
  say(`${S.implicit_target ? 'Target' : cap(f.name)} set to null (there is none)`, 'ok');
  advanceActive();
  render();
}

function switchField(dir: number): void {
  const n = S.spans.length;
  if (n < 2) return;
  st.active = (st.active + dir + n) % n;
  say(`active field: ${S.spans[st.active]!.name}`);
  render();
}

function cycleSpanStatus(): void {
  const f = S.spans[st.active]!;
  const d = st.draft;
  if (f.statuses.length === 0) {
    say(`span ${f.name} declares no statuses`, 'err');
    return;
  }
  if (isNullFor(f, d.type)) {
    say(`${f.name} is null for ${d.type} \u2014 it has no status`, 'err');
    return;
  }
  const now = d.spanStatus.get(f.name) ?? f.statuses[0]!;
  const next = f.statuses[(f.statuses.indexOf(now) + 1) % f.statuses.length]!;
  d.spanStatus.set(f.name, next);
  st.dirty = true;
  hintMsg = null;
  say(`${f.name} status: ${next}`, 'ok');
  render();
}

function toggleSnap(): void {
  st.snap = !st.snap;
  say(`mouse selection snaps to ${st.snap ? 'words' : 'characters'}`);
  render();
}

function discard(): void {
  if (!st.dirty) {
    say('nothing to discard');
    return;
  }
  loadDraft();
  say('draft discarded');
  render();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function nextOpen(dir: number): number {
  const n = recs.length;
  for (let k = 1; k < n; k++) {
    const j = (((st.i + dir * k) % n) + n) % n;
    if (!recs[j]!.label) return j;
  }
  return -1;
}

function go(i: number, quiet = false): void {
  const was = st.dirty;
  st.i = i;
  loadDraft();
  if (was && !quiet) say('unsaved draft discarded', 'warn');
  render();
}

function step(dir: number): void {
  const j = st.i + dir;
  if (j < 0) return say('first record', 'err');
  if (j >= recs.length) return say(recs.length < total ? 'still loading more records\u2026' : 'last record', recs.length < total ? '' : 'err');
  go(j);
}

function jumpOpen(dir: number): void {
  const j = nextOpen(dir);
  if (j < 0) return say(recs.length < total ? 'no other unlabelled record loaded yet \u2014 still loading' : 'no other unlabelled record');
  go(j);
}

// ---------------------------------------------------------------------------
// Saving, undo, proposals
// ---------------------------------------------------------------------------

function setLabel(r: Rec, L: Label | null): void {
  r.label = L;
  recount();
  paintRow(r);
}

/** PUT `label` for `r`, then move on to the next record without a label. */
async function commit(r: Rec, label: Label, done: string): Promise<void> {
  busy = true;
  try {
    const out = await api<{ label?: Label }>('PUT', `${base}/labels/${encodeURIComponent(r.id)}`, { label });
    undoStack.push({ id: r.id, prev: r.label });
    setLabel(r, out.label ?? label);
    st.dirty = false;
    const j = nextOpen(1);
    if (j >= 0) go(j, true);
    else {
      loadDraft();
      render();
    }
    const allDone = j < 0 && recs.length >= total && tally.labelled >= total;
    say(`${done} \u00b7 z undo` + (allDone ? ' \u00b7 every record is labelled \u2014 nice work' : ''), 'ok');
  } catch (e) {
    if (e instanceof Ended) return;
    const m = errMsg(e);
    setHint(m);
    say(m, 'err');
  } finally {
    busy = false;
  }
}

async function save(status: string): Promise<void> {
  if (busy) return;
  const r = cur();
  const d = st.draft;
  if (!S.statuses.some((s) => s.name === status)) return refuse(`this schema has no "${status}" status`);
  const clears = S.null_label_statuses.includes(status);
  if (!clears && status === 'complete') {
    if (d.type == null) return refuse(`pick a type first (1\u2013${nTypeKeys()}), or press s to skip`);
    const miss = firstUnmarked(d);
    if (miss) {
      st.active = S.spans.indexOf(miss);
      render();
      return refuse(`${miss.name} isn't marked \u2014 click the text, or press n if there is none`);
    }
  }
  await commit(r, buildLabel(r, status, d), 'saved');
}

async function undo(): Promise<void> {
  if (busy) return;
  const u = undoStack.pop();
  if (!u) return say('nothing to undo', 'err');
  const idx = byId.get(u.id);
  if (idx === undefined) return;
  const r = recs[idx]!;
  busy = true;
  try {
    if (u.prev) {
      const out = await api<{ label?: Label }>('PUT', `${base}/labels/${encodeURIComponent(u.id)}`, { label: u.prev });
      setLabel(r, out.label ?? u.prev);
    } else {
      await api<unknown>('DELETE', `${base}/labels/${encodeURIComponent(u.id)}`);
      setLabel(r, null);
    }
    go(idx, true);
    say(`undone \u2014 back on ${u.id}` + (u.prev ? ' with its previous label' : ', unlabelled again'), 'ok');
  } catch (e) {
    undoStack.push(u);
    if (e instanceof Ended) return;
    const m = errMsg(e);
    setHint(m);
    say(`undo failed: ${m}`, 'err');
  } finally {
    busy = false;
  }
}

async function acceptProposal(): Promise<void> {
  if (!project.show_proposals || busy) return;
  const r = cur();
  const info = propInfo(r);
  if (!info) return say(`no proposal for ${r.id}`, 'err');
  if (info.error || !info.label) return refuse(`\u26a0 invalid: ${info.error}`);
  await commit(r, info.label, 'accepted the proposal');
}

function loadProposal(): void {
  if (!project.show_proposals) return;
  const r = cur();
  const info = propInfo(r);
  if (!info) return say(`no proposal for ${r.id}`, 'err');
  if (info.error || !info.draft) return refuse(`\u26a0 invalid: ${info.error}`);
  st.draft = info.draft;
  st.dirty = true;
  st.sel = null;
  st.active = firstOpenField(info.draft.type);
  hintMsg = null;
  say('proposal loaded into draft \u2014 edit, then enter/u/s to save', 'ok');
  render();
}

// ---------------------------------------------------------------------------
// Keyboard span mode (x)
// ---------------------------------------------------------------------------

function startSpan(): void {
  const r = cur();
  const v = view(r);
  const f = S.spans[st.active]!;
  if (isNullFor(f, st.draft.type)) return say(lockedMsg(f), 'err');
  if (v.chars.length === 0) return say('this record has no text', 'err');
  const ex = st.draft.spans.get(f.name);
  const w = v.words[0];
  st.sel = ex ? { a: ex.start, h: ex.end - 1 } : w ? { a: w.start, h: w.end - 1 } : { a: 0, h: 0 };
  hintMsg = null;
  render();
}

function spanKey(e: KeyboardEvent): void {
  const s = st.sel;
  if (!s) return;
  const r = cur();
  const v = view(r);
  const n = v.chars.length;
  const k = e.key;
  const clamp = (x: number): number => Math.max(0, Math.min(n - 1, x));
  const lo = (): number => Math.min(s.a, s.h);
  const hi = (): number => Math.max(s.a, s.h);
  const pickWord = (w: Word): void => {
    s.a = w.start;
    s.h = w.end - 1;
  };
  const under = (): Word | null => {
    const i = wordIdx(v, s.h);
    return i >= 0 ? (v.words[i] ?? null) : null;
  };
  const isSel = (w: Word | null): boolean => !!w && lo() === w.start && hi() === w.end - 1;
  const single = (): boolean => lo() === hi() && wordIdx(v, lo()) < 0;
  const firstWord = (pred: (w: Word) => boolean): Word | undefined => v.words.find(pred);
  const lastWord = (pred: (w: Word) => boolean): Word | undefined => {
    for (let i = v.words.length - 1; i >= 0; i--) if (pred(v.words[i]!)) return v.words[i];
    return undefined;
  };
  let handled = true;
  switch (k) {
    case 'h':
    case 'ArrowLeft':
      if (e.shiftKey) s.h = clamp(s.h - 1);
      else s.a = s.h = clamp(s.h - 1);
      break;
    case 'l':
    case 'ArrowRight':
      if (e.shiftKey) s.h = clamp(s.h + 1);
      else s.a = s.h = clamp(s.h + 1);
      break;
    case 'H':
      s.h = clamp(s.h - 1);
      break;
    case 'L':
      s.h = clamp(s.h + 1);
      break;
    case 'w': {
      const w = under();
      if (w && !isSel(w)) pickWord(w);
      else {
        const nx = firstWord((x) => x.start > hi());
        if (nx) pickWord(nx);
        else say('no next word');
      }
      break;
    }
    case 'b': {
      const w = under();
      if (w && !isSel(w)) pickWord(w);
      else {
        const pv = lastWord((x) => x.end - 1 < lo());
        if (pv) pickWord(pv);
        else say('no previous word');
      }
      break;
    }
    case 'W': {
      if (single()) {
        const nx = firstWord((x) => x.start > hi());
        if (nx) pickWord(nx);
      } else {
        const nx = firstWord((x) => x.end - 1 > s.h);
        if (nx) s.h = nx.end - 1;
        else say('no next word');
      }
      break;
    }
    case 'B': {
      if (single()) {
        const pv = lastWord((x) => x.end - 1 < lo());
        if (pv) pickWord(pv);
      } else {
        const pv = lastWord((x) => x.start < s.h);
        if (pv) s.h = pv.start;
        else say('no previous word');
      }
      break;
    }
    case '0':
    case 'Home':
      s.a = s.h = 0;
      break;
    case '$':
    case 'End':
      s.a = s.h = n - 1;
      break;
    case 'Enter': {
      e.preventDefault();
      if (e.repeat) return;
      if (isSpaceCh(v.chars[lo()]) || isSpaceCh(v.chars[hi()])) {
        say('the selection starts or ends with a space \u2014 move it onto letters', 'err');
        break;
      }
      const sp = mkSpan(r, lo(), hi());
      st.sel = null;
      if (sp) setSpan(sp);
      else render();
      return;
    }
    case 'n':
      e.preventDefault();
      nullField();
      return;
    case 'Escape':
      st.sel = null;
      say('span selection cancelled');
      break;
    case 'Tab':
      if (S.spans.length > 1) {
        st.active = (st.active + (e.shiftKey ? -1 : 1) + S.spans.length) % S.spans.length;
        say(`writing to: ${S.spans[st.active]!.name}`);
      } else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
  render();
}

// ---------------------------------------------------------------------------
// Mouse: click a word, drag a range, double-click snaps to a word
// ---------------------------------------------------------------------------

function bindMouse(box: HTMLElement): void {
  interface Down { a: number; h: number; dbl: boolean; moved: boolean }
  let down: Down | null = null;
  let lastT = 0;
  let lastI = -2;

  /** Code-point index under the pointer; falls back to the nearest character when the pointer is in the line gaps of the text box. */
  const at = (x: number, y: number): number => {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return -1;
    const c = hit.closest('.c');
    if (c && box.contains(c)) return Number((c as HTMLElement).dataset.i);
    if (hit !== box) return -1;
    let best = -1;
    let bestD = Infinity;
    const kids = box.children;
    for (let i = 0; i < kids.length; i++) {
      const rc = kids[i]!.getBoundingClientRect();
      const dx = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
      const dy = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
      const d = dy * 4 + dx; // prefer the same line
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const range = (d: Down): [number, number] =>
    d.dbl || st.snap ? snapRange(view(cur()), d.a, d.h) : [Math.min(d.a, d.h), Math.max(d.a, d.h)];

  const tip = (x: number, y: number): void => {
    const txt = pendReadout();
    if (txt === null) {
      $.dragtip.hidden = true;
      return;
    }
    $.dragtip.textContent = txt;
    $.dragtip.hidden = false;
    const w = $.dragtip.offsetWidth;
    $.dragtip.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - w - 8))}px`;
    $.dragtip.style.top = `${Math.max(8, y - 44)}px`;
  };

  box.addEventListener('selectstart', (e) => e.preventDefault());
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || helpOpen || busy || !ready) return;
    const i = at(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    const now = Date.now();
    const dbl = i === lastI && now - lastT < 450;
    lastT = now;
    lastI = i;
    if (!dbl) st.advFrom = undefined;
    down = { a: i, h: i, dbl, moved: false };
    const [lo, hi] = range(down);
    st.pend = { lo, hi };
    paint();
  });
  document.addEventListener('pointermove', (e) => {
    if (!down) return;
    const i = at(e.clientX, e.clientY);
    if (i < 0 || i === down.h) {
      if (down.moved) tip(e.clientX, e.clientY);
      return;
    }
    down.h = i;
    down.moved = true;
    const [lo, hi] = range(down);
    st.pend = { lo, hi };
    paint();
    tip(e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', () => {
    if (!down) return;
    const d = down;
    down = null;
    st.pend = null;
    $.dragtip.hidden = true;
    const [lo, hi] = range(d);
    const sp = mkSpan(cur(), lo, hi);
    if (d.dbl && st.advFrom !== undefined) {
      st.active = st.advFrom;
      st.advFrom = undefined;
    }
    if (!sp) {
      say("a space can't be marked \u2014 click a word", 'err');
      render();
      return;
    }
    st.sel = null;
    setSpan(sp);
  });
  document.addEventListener('pointercancel', () => {
    if (!down) return;
    down = null;
    st.pend = null;
    $.dragtip.hidden = true;
    paint();
  });
}

// ---------------------------------------------------------------------------
// Help overlay and drawer
// ---------------------------------------------------------------------------

function toggleHelp(v: boolean): void {
  helpOpen = v;
  $.help.hidden = !v;
}

function toggleDrawer(v = !drawerOpen): void {
  drawerOpen = v;
  $.drawer.classList.toggle('open', v);
  $.drawer.setAttribute('aria-hidden', String(!v));
  document.body.classList.toggle('drawer-open', v);
  el<HTMLElement>('bQueue').setAttribute('aria-expanded', String(v));
  if (v) recs[st.i]?.row?.scrollIntoView({ block: 'center' });
}

interface KeyRow { keys: string[]; text: string }

function keymapRows(): KeyRow[] {
  return [
    { keys: [`1\u2013${nTypeKeys()}`], text: 'set the type (schema order)' },
    { keys: ['enter', 'u', 's'], text: 'save as complete \u00b7 uncertain \u00b7 skipped, then jump to the next unlabelled record (complete is refused while a target is unmarked, see below)' },
    { keys: ['x'], text: 'mark the active field with the keyboard: \u2190/\u2192 (h/l) move, shift+\u2190/\u2192 (H/L) extend, w/b move and W/B extend by word, 0/home and $/end ends, enter accepts, esc cancels' },
    { keys: ['n'], text: 'null the active field (there is none)' },
    { keys: ['tab', 'shift+tab'], text: 'switch the active span field (schemas with more than one span)' },
    { keys: ['c'], text: "cycle the active field's span status (fields that declare statuses)" },
    { keys: ['j', 'k', '\u2190', '\u2192'], text: 'next \u00b7 previous record in the whole queue (\u2193 \u2191 work too)' },
    { keys: [']', '['], text: 'next \u00b7 previous unlabelled record' },
    { keys: ['z'], text: 'undo the last save, repeatedly, back to the start of this session' },
    { keys: ['p', 'P'], text: 'accept the proposal (saves, z undoes) \u00b7 load it into the draft (projects that show proposals)' },
    { keys: ['m'], text: 'mouse snaps to words \u2194 characters (use characters for CJK)' },
    { keys: ['\\', '`'], text: 'open or close the queue drawer' },
    { keys: ['esc'], text: 'discard the unsaved draft (closes the queue drawer when there is none)' },
    { keys: ['?'], text: 'show / hide this help' },
    { keys: [], text: 'mouse: click a word \u00b7 drag a range \u00b7 double-click selects a word \u00b7 click a queue row to jump \u00b7 click a type or a save button' },
  ];
}

function fillKeymap(): void {
  const table = $.helpKeys;
  table.textContent = '';
  for (const row of keymapRows()) {
    const tr = mk('tr');
    const th = mk('th');
    row.keys.forEach((k, i) => {
      if (i > 0) th.append(' ');
      th.appendChild(mk('kbd', undefined, k));
    });
    if (row.keys.length === 0) th.textContent = 'mouse';
    tr.appendChild(th);
    tr.appendChild(mk('td', undefined, row.text));
    table.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Global keyboard
// ---------------------------------------------------------------------------

function onKey(e: KeyboardEvent): void {
  if (!ready || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const k = e.key;
  if (helpOpen) {
    if (k === 'Escape' || k === '?' || k === 'Enter') toggleHelp(false);
    e.preventDefault();
    return;
  }
  if (k === '?') {
    e.preventDefault();
    toggleHelp(true);
    return;
  }
  if (k === '\\' || k === '`') {
    e.preventDefault();
    toggleDrawer();
    return;
  }
  const ae = document.activeElement;
  if (k === 'Enter' && ae instanceof HTMLElement && (ae.tagName === 'BUTTON' || ae.tagName === 'A')) return; // let a focused control activate
  if (busy) return;
  if (hintMsg) {
    hintMsg = null;
    renderHint();
  }
  if (st.sel) {
    spanKey(e);
    return;
  }
  let handled = true;
  if (/^[1-9]$/.test(k)) setType(Number(k) - 1);
  else {
    switch (k) {
      case 'Enter':
        if (!e.repeat) void save('complete');
        break;
      case 'u':
        if (!e.repeat) void save('uncertain');
        break;
      case 's':
        if (!e.repeat) void save('skipped');
        break;
      case 'x':
        startSpan();
        break;
      case 'n':
        nullField();
        break;
      case 'z':
      case 'Z':
        if (!e.repeat) void undo();
        break;
      case 'j':
      case 'ArrowDown':
      case 'ArrowRight':
        step(1);
        break;
      case 'k':
      case 'ArrowUp':
      case 'ArrowLeft':
        step(-1);
        break;
      case ']':
        jumpOpen(1);
        break;
      case '[':
        jumpOpen(-1);
        break;
      case 'p':
        if (project.show_proposals) {
          if (!e.repeat) void acceptProposal();
        } else handled = false;
        break;
      case 'P':
        if (project.show_proposals) loadProposal();
        else handled = false;
        break;
      case 'Escape':
        if (st.dirty) discard();
        else if (drawerOpen) toggleDrawer(false);
        else say('nothing to discard');
        break;
      case 'm':
        toggleSnap();
        break;
      case 'Tab':
        if (S.spans.length > 1) switchField(e.shiftKey ? -1 : 1);
        else handled = false;
        break;
      case 'c':
        cycleSpanStatus();
        break;
      default:
        handled = false;
    }
  }
  if (handled) e.preventDefault();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function fatal(message: string, backLink = true): void {
  $.fatal.textContent = message;
  if (backLink) {
    $.fatal.append(' ');
    const a = mk('a', undefined, '\u2190 your projects');
    a.href = '/';
    $.fatal.appendChild(a);
  }
  $.fatal.hidden = false;
  $.stage.hidden = true;
}

function setLoadNote(text: string, err = false): void {
  $.loadNote.hidden = text === '';
  $.loadNote.textContent = text;
  $.loadNote.classList.toggle('err', err);
}

/** Append one page of items to the in-memory queue and the drawer. */
function appendItems(items: ItemRow[]): void {
  const frag = document.createDocumentFragment();
  let firstOpen = -1;
  for (const it of items) {
    if (byId.has(it.id)) continue; // never keep a record twice
    const r: Rec = {
      id: it.id,
      position: it.position,
      text: it.text,
      label: it.label ?? null,
      proposal: project.show_proposals ? (it.proposal ?? null) : null,
      v: null,
      row: null,
    };
    const idx = recs.push(r) - 1;
    byId.set(r.id, idx);
    if (firstOpen < 0 && !r.label) firstOpen = idx;
    frag.appendChild(buildRow(r, idx));
  }
  $.queueList.appendChild(frag);
  recount();
  if (ready && st.autoPlace && !st.touched && firstOpen >= 0) {
    st.autoPlace = false;
    go(firstOpen, true);
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
    if (e instanceof ApiError && e.status === 404) fatal('project not found or not assigned.');
    else fatal(`could not load the project: ${errMsg(e)}`);
    return;
  }
  try {
    S = parseSchema(project.schema);
  } catch (e) {
    fatal(`this project's schema is not usable: ${e instanceof SchemaError ? e.message : errMsg(e)}`);
    return;
  }
  document.title = `${project.name} \u00b7 quet`;
  $.projName.textContent = project.name;

  let first: ItemsPage;
  try {
    first = await api<ItemsPage>('GET', `${base}/items?offset=0&limit=${PAGE}`);
  } catch (e) {
    if (e instanceof Ended) return;
    fatal(`could not load the queue: ${errMsg(e)}`);
    return;
  }
  total = first.total;
  appendItems(first.items);
  if (recs.length === 0) {
    fatal('this project has no records yet.');
    return;
  }

  $.typeRange.textContent = `(press 1\u2013${nTypeKeys()})`;
  $.bField.hidden = S.spans.length < 2;
  $.bStatus.hidden = !S.spans.some((f) => f.statuses.length > 0);
  fillKeymap();

  const open = recs.findIndex((r) => !r.label);
  st.i = Math.max(0, open);
  st.autoPlace = open < 0 && recs.length < total;
  loadDraft();
  $.stage.hidden = false;
  ready = true;
  render();
  void loadRest();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.addEventListener('mousedown', (e) => {
  if (e.target instanceof Element && e.target.closest('button')) e.preventDefault(); // keep keyboard focus on the page
});
document.addEventListener('keydown', () => {
  st.touched = true;
}, true);
document.addEventListener('pointerdown', () => {
  st.touched = true;
}, true);
document.addEventListener('keydown', onKey);

bindMouse($.text);
on(el('bUndo'), () => void undo());
el('bHelp').addEventListener('click', () => toggleHelp(true));
el('bQueue').addEventListener('click', () => toggleDrawer());
el('bDrawerClose').addEventListener('click', () => toggleDrawer(false));
on(el('bSelect'), startSpan);
on(el('bNull'), nullField);
on(el('bField'), () => switchField(1));
on(el('bStatus'), cycleSpanStatus);
on(el('bSnap'), toggleSnap);
on(el('bPrev'), () => step(-1));
on(el('bNext'), () => step(1));
on(el('bOpenPrev'), () => jumpOpen(-1));
on(el('bOpenNext'), () => jumpOpen(1));
$.help.addEventListener('click', (e) => {
  if (e.target === $.help) toggleHelp(false);
});
$.queueList.addEventListener('click', (e) => {
  if (busy || !(e.target instanceof Element)) return;
  const b = e.target.closest<HTMLElement>('.qrow');
  if (!b) return;
  const i = Number(b.dataset.i);
  if (Number.isInteger(i) && recs[i]) go(i);
});

void boot();
