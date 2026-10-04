// Quet admin dashboard. Talks only to /api/admin/* (contract.md, "Admin API").
// All DOM is built with createElement/textContent: no innerHTML, no inline styles (CSP).

import type { Schema } from '../shared/schema';
import { mountThemePicker } from './theme';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ProjectRow {
  slug: string;
  name: string;
  items: number;
  proposals: number;
  collaborators: number;
  created_at: number;
  updated_at: number;
}

interface CollabRow {
  username: string;
  disabled: boolean;
  created_at: number;
  projects: string[];
}

interface Progress {
  username: string;
  disabled: boolean;
  labelled: number;
  complete: number;
  uncertain: number;
  skipped: number;
  last_label_at: number | null;
}

interface ProjectInfo {
  slug: string;
  name: string;
  schema: Schema;
  schema_yaml: string;
  show_proposals: boolean;
  items: number;
  proposals: number;
  created_at: number;
  updated_at: number;
}

interface ProjectDetail {
  project: ProjectInfo;
  collaborators: Progress[];
}

interface SecretResponse {
  username: string;
  password?: string;
}

type Kind = 'p' | 'c';

interface DetailState {
  kind: Kind;
  key: string;
  data: ProjectDetail | null;
  loading: boolean;
  error: unknown;
}

interface SortState {
  key: string;
  dir: 1 | -1;
}

interface Col<T> {
  key: string;
  label: string;
  num?: boolean;
  time?: boolean;
  value: (row: T) => string | number;
}

/* ------------------------------------------------------------------ */
/* Constants & state                                                   */
/* ------------------------------------------------------------------ */

const PUBLIC_ORIGIN = location.origin;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

const shareUrl = (slug: string): string => `${PUBLIC_ORIGIN}/p/${slug}`;
const enc = encodeURIComponent;

let projects: ProjectRow[] = [];
let collabs: CollabRow[] = [];
let listsLoaded = false;
let filter = '';
let detail: DetailState | null = null;
let detailToken = 0;
const selected: Record<Kind, string | null> = { p: null, c: null };
let lastKind: Kind = 'p';
let sortP: SortState = { key: 'updated_at', dir: -1 };
let sortC: SortState = { key: 'username', dir: 1 };

const PROJECT_COLS: Col<ProjectRow>[] = [
  { key: 'slug', label: 'Slug', value: (r) => r.slug },
  { key: 'name', label: 'Name', value: (r) => r.name.toLowerCase() },
  { key: 'items', label: 'Items', num: true, value: (r) => r.items },
  { key: 'proposals', label: 'Proposals', num: true, value: (r) => r.proposals },
  { key: 'collaborators', label: 'Collabs', num: true, value: (r) => r.collaborators },
  { key: 'updated_at', label: 'Updated', time: true, value: (r) => r.updated_at },
];

const COLLAB_COLS: Col<CollabRow>[] = [
  { key: 'username', label: 'Username', value: (r) => r.username },
  { key: 'disabled', label: 'Status', value: (r) => (r.disabled ? 1 : 0) },
  { key: 'projects', label: 'Projects', value: (r) => r.projects.length },
  { key: 'created_at', label: 'Created', time: true, value: (r) => r.created_at },
];

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

type AttrValue = string | number | boolean | null | undefined | ((ev: Event) => void);
type Attrs = Record<string, AttrValue>;
type Child = Node | string | number | null | undefined | false | Child[];

function appendKids(parent: Node, kids: Child[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) appendKids(parent, kid);
    else if (typeof kid === 'string' || typeof kid === 'number') parent.appendChild(document.createTextNode(String(kid)));
    else parent.appendChild(kid);
  }
}

/** Create an element. Function-valued attrs are event listeners keyed by event name. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k, v);
      else if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendKids(el, kids);
  return el;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`admin.html is missing #${id}`);
  return el as T;
}

function clear(el: Element): void {
  el.replaceChildren();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '–';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '–';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeEl(ms: number | null | undefined): Node {
  if (!ms || Number.isNaN(new Date(ms).getTime())) return h('span', { class: 'muted' }, 'Never');
  return h('time', { datetime: new Date(ms).toISOString(), title: new Date(ms).toISOString() }, fmtTime(ms));
}

function badge(text: string, cls = ''): HTMLElement {
  return h('span', { class: `badge ${cls}`.trim() }, text);
}

function chips(values: string[]): Node {
  if (values.length === 0) return h('span', { class: 'muted' }, 'None');
  return h('span', { class: 'chips' }, values.map((v) => h('span', { class: 'chip' }, v)));
}

/* ------------------------------------------------------------------ */
/* Icons (Lucide, inline SVG)                                          */
/* ------------------------------------------------------------------ */

const ICON_PATHS = {
  'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  minus: '<path d="M5 12h14"/>',
  'panel-right-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'user-check': '<path d="m16 11 2 2 4-4"/><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
  'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
  'user-x': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;
type IconName = keyof typeof ICON_PATHS;
const iconProtos = new Map<IconName, SVGSVGElement>();

function icon(name: IconName, cls = 'ic'): SVGSVGElement {
  let proto = iconProtos.get(name);
  if (!proto) {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`,
      'image/svg+xml',
    );
    proto = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    iconProtos.set(name, proto);
  }
  const svg = proto.cloneNode(true) as SVGSVGElement;
  svg.setAttribute('class', cls);
  return svg;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`, {});
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const rec: Record<string, unknown> =
      typeof data === 'object' && data !== null && !Array.isArray(data) ? Object.fromEntries(Object.entries(data)) : {};
    const msg = typeof rec['error'] === 'string' && rec['error'] ? rec['error'] : `HTTP ${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, msg, rec);
  }
  if (data === null) {
    throw new ApiError(res.status, 'Unexpected non-JSON response from the server (is the Access session still valid?)', {});
  }
  return data as T;
}

/* ------------------------------------------------------------------ */
/* Inline messages                                                     */
/* ------------------------------------------------------------------ */

function describeItem(item: unknown): string {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const fields = Object.entries(item);
    const head = fields.filter(([k, v]) => (k === 'collaborator' || k === 'id') && typeof v === 'string' && v).map(([, v]) => String(v));
    const rest = fields
      .filter(([k]) => k !== 'collaborator' && k !== 'id')
      .map(([k, v]) => (typeof v === 'string' ? v : `${k}: ${JSON.stringify(v)}`));
    return [head.join(' / '), ...rest].filter(Boolean).join(', ');
  }
  return JSON.stringify(item);
}

/** Render an error (message + any list members such as the 409 `invalid` list) into `slot`. */
function showError(slot: HTMLElement, err: unknown): void {
  clear(slot);
  slot.classList.add('has');
  const msg = err instanceof Error ? err.message : String(err);
  const body = h('div', { class: 'alert-body' }, h('span', { class: 'msg' }, msg));
  if (err instanceof ApiError) {
    for (const [key, value] of Object.entries(err.body)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const label = key === 'invalid' ? `Invalid (${value.length}${value.length >= 50 ? '+' : ''})` : key;
      body.appendChild(
        h(
          'details',
          { class: 'err-list', open: true },
          h('summary', null, label),
          h('ul', null, value.map((item) => h('li', null, describeItem(item)))),
        ),
      );
    }
  }
  slot.append(icon('circle-alert', 'ic alert-ic'), body);
}

/** Transient success notice (shadcn Sonner look), auto-dismissed. */
function toast(msg: string): void {
  const host = byId('toasts');
  const node = h('div', { class: 'toast' }, icon('circle-check', 'ic toast-ic'), h('span', null, msg));
  host.appendChild(node);
  while (host.children.length > 4) host.firstElementChild?.remove();
  window.setTimeout(() => node.remove(), 5000);
}

function clearMsg(slot: HTMLElement): void {
  clear(slot);
  slot.classList.remove('has');
}

function errSlot(): HTMLElement {
  return h('div', { class: 'inline-err', role: 'alert' });
}

/** Run a mutation with the button disabled; errors land in `slot`. */
async function run(slot: HTMLElement, btn: HTMLButtonElement | null, fn: () => Promise<void>): Promise<void> {
  clearMsg(slot);
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    showError(slot, e);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = h('textarea', { class: 'offscreen', readonly: true, 'aria-hidden': 'true', tabindex: -1 });
  ta.value = text;
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (prev instanceof HTMLElement) prev.focus();
  if (!ok) throw new Error('Copy failed: select the text and copy it manually');
}

function copyButton(label: string, getText: () => string, slot: HTMLElement, fk?: string, cls = 'btn outline sm', aria?: string): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: cls, 'data-fk': fk, 'aria-label': aria, title: aria });
  const render = (done: boolean): void => {
    btn.replaceChildren(icon(done ? 'check' : 'copy'), h('span', { class: 'lbl' }, done ? 'Copied' : label));
  };
  render(false);
  let timer = 0;
  btn.addEventListener('click', () => {
    void copyText(getText()).then(
      () => {
        clearMsg(slot);
        render(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => render(false), 1600);
      },
      (e: unknown) => showError(slot, e),
    );
  });
  return btn;
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

function confirmDialog(title: string, body: Child, okLabel: string, destructive = true): Promise<boolean> {
  const dlg = byId<HTMLDialogElement>('confirm');
  byId('confirm-title').textContent = title;
  const bodyEl = byId('confirm-body');
  clear(bodyEl);
  appendKids(bodyEl, [body]);
  const ok = byId<HTMLButtonElement>('confirm-ok');
  ok.textContent = okLabel;
  ok.classList.toggle('destructive', destructive);
  ok.classList.toggle('primary', !destructive);
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    byId<HTMLButtonElement>('confirm-cancel').focus();
  });
}

/* ------------------------------------------------------------------ */
/* Focus preservation across re-renders                                */
/* ------------------------------------------------------------------ */

function withFocus(fn: () => void): void {
  const active = document.activeElement;
  let fk: string | null = null;
  let bodyId: string | null = null;
  let rowIdx = -1;
  if (active instanceof HTMLElement && active !== document.body) {
    fk = active.getAttribute('data-fk');
    const row = active.closest('tr[data-row]');
    const tbody = row?.parentElement;
    if (row && tbody) {
      bodyId = tbody.id;
      rowIdx = Array.prototype.indexOf.call(tbody.children, row);
    }
  }
  fn();
  if (fk === null && bodyId === null) return;
  if (fk !== null) {
    for (const el of document.querySelectorAll<HTMLElement>('[data-fk]')) {
      if (el.getAttribute('data-fk') === fk) {
        el.focus();
        return;
      }
    }
  }
  if (bodyId) {
    const rows = document.querySelectorAll<HTMLElement>(`#${bodyId} tr[data-row]`);
    rows[Math.min(rowIdx, rows.length - 1)]?.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Sorting / filtering                                                 */
/* ------------------------------------------------------------------ */

function sortRows<T>(rows: T[], cols: Col<T>[], s: SortState): T[] {
  const col = cols.find((c) => c.key === s.key) ?? cols[0];
  const first = cols[0];
  if (!col || !first) return rows;
  const cmp = (a: string | number, b: string | number): number =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return [...rows].sort((a, b) => s.dir * cmp(col.value(a), col.value(b)) || cmp(first.value(a), first.value(b)));
}

function matches(haystack: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  const hay = haystack.toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

function renderHead<T>(
  thead: HTMLElement,
  tableId: string,
  cols: Col<T>[],
  sort: SortState,
  onSort: (key: string) => void,
): void {
  clear(thead);
  thead.appendChild(
    h(
      'tr',
      null,
      cols.map((c) => {
        const active = sort.key === c.key;
        return h(
          'th',
          {
            scope: 'col',
            class: `${c.num ? 'num' : ''} ${c.time ? 'col-time' : ''}`.trim(),
            'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none',
          },
          h(
            'button',
            { type: 'button', class: 'sort', 'data-fk': `sort:${tableId}:${c.key}`, click: () => onSort(c.key) },
            c.label,
            icon(active ? (sort.dir === 1 ? 'chevron-up' : 'chevron-down') : 'arrow-up-down', active ? 'ic sort-ic on' : 'ic sort-ic'),
          ),
        );
      }),
      h('th', { scope: 'col', class: 'actions-h' }, 'Actions'),
    ),
  );
}

function tabIndexFor(kind: Kind, keys: string[], key: string): number {
  const cur = selected[kind];
  const active = cur !== null && keys.includes(cur) ? cur : keys[0];
  return key === active ? 0 : -1;
}

function actionBtn(
  label: string,
  fk: string,
  onClick: (btn: HTMLButtonElement) => void,
  aria: string,
  cls = 'ghost',
  ic?: IconName,
): HTMLButtonElement {
  const btn = h(
    'button',
    { type: 'button', class: `btn sm ${cls}`.trim(), 'data-fk': fk, 'aria-label': aria, title: aria },
    ic ? icon(ic) : null,
    h('span', { class: 'lbl' }, label),
  );
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

function emptyRow(span: number, ic: IconName, title: string, desc: string): HTMLElement {
  return h(
    'tr',
    { class: 'empty' },
    h('td', { colspan: span }, h('div', { class: 'empty-state' }, icon(ic, 'ic empty-ic'), h('p', { class: 'empty-title' }, title), h('p', { class: 'empty-desc' }, desc))),
  );
}

/* ------------------------------------------------------------------ */
/* Projects table                                                      */
/* ------------------------------------------------------------------ */

function renderProjects(): void {
  withFocus(() => {
    renderHead(byId('projects-head'), 'p', PROJECT_COLS, sortP, (key) => {
      sortP = { key, dir: sortP.key === key ? (sortP.dir === 1 ? -1 : 1) : key === 'slug' || key === 'name' ? 1 : -1 };
      renderProjects();
    });
    const body = byId('projects-body');
    clear(body);
    const rows = sortRows(
      projects.filter((p) => matches(`${p.slug} ${p.name}`)),
      PROJECT_COLS,
      sortP,
    );
    byId('projects-count').textContent = listsLoaded
      ? rows.length === projects.length
        ? `${projects.length}`
        : `${rows.length} of ${projects.length}`
      : '';
    const keys = rows.map((r) => r.slug);
    if (rows.length === 0) {
      const span = PROJECT_COLS.length + 1;
      body.appendChild(
        !listsLoaded
          ? emptyRow(span, 'folder-open', 'Loading projects', '')
          : projects.length === 0
            ? emptyRow(span, 'folder-open', 'No projects yet', 'Push one from the Quet CLI with quet web push.')
            : emptyRow(span, 'folder-open', 'No matching projects', 'Try a different filter.'),
      );
      return;
    }
    for (const p of rows) {
      const slot = errSlot();
      const open = detail?.kind === 'p' && detail.key === p.slug;
      body.appendChild(
        h(
          'tr',
          {
            'data-row': 'p',
            'data-key': p.slug,
            'data-fk': `p:${p.slug}`,
            tabindex: tabIndexFor('p', keys, p.slug),
            'aria-current': open ? 'true' : null,
            class: open ? 'open' : '',
          },
          h('td', { class: 'mono strong nowrap' }, p.slug),
          h('td', { class: 'name' }, p.name),
          h('td', { class: 'num' }, p.items),
          h('td', { class: 'num' }, p.proposals),
          h('td', { class: 'num' }, p.collaborators),
          h('td', { class: 'nowrap muted col-time' }, timeEl(p.updated_at)),
          h(
            'td',
            { class: 'actions' },
            h(
              'div',
              { class: 'btns' },
              actionBtn('Open', `p:${p.slug}:open`, () => void openDetail('p', p.slug, true), `Open project ${p.slug}`, 'outline', 'panel-right-open'),
              copyButton('Copy link', () => shareUrl(p.slug), slot, `p:${p.slug}:copy`, 'btn ghost sm', `Copy shareable link for ${p.slug}`),
              actionBtn('Delete', `p:${p.slug}:delete`, (btn) => void deleteProject(p, slot, btn), `Delete project ${p.slug}`, 'ghost danger', 'trash-2'),
            ),
            slot,
          ),
        ),
      );
    }
  });
}

async function deleteProject(p: ProjectRow, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  const ok = await confirmDialog(
    `Delete project “${p.slug}”?`,
    h(
      'div',
      null,
      h('p', null, `This permanently deletes ${p.items} item(s), ${p.proposals} proposal(s), all assignments and `, h('strong', null, 'every label by every collaborator'), ' in this project.'),
      h('p', null, 'Pulled labels in Quet files are not affected. This cannot be undone.'),
    ),
    'Delete project',
  );
  if (!ok) return;
  await run(slot, btn, async () => {
    await api('DELETE', `/api/admin/projects/${enc(p.slug)}`);
    if (detail?.kind === 'p' && detail.key === p.slug) closeDetail(false);
    await reloadLists();
    toast(`Deleted project ${p.slug}`);
  });
}

/* ------------------------------------------------------------------ */
/* Collaborators table                                                 */
/* ------------------------------------------------------------------ */

function projectLinks(slugs: string[]): Node {
  if (slugs.length === 0) return h('span', { class: 'muted' }, 'None');
  return h(
    'span',
    { class: 'chips' },
    slugs.map((s) =>
      h('button', { type: 'button', class: 'chip link', title: `Open project ${s}`, click: () => void openDetail('p', s, true) }, s),
    ),
  );
}

function renderCollabs(): void {
  withFocus(() => {
    renderHead(byId('collabs-head'), 'c', COLLAB_COLS, sortC, (key) => {
      sortC = { key, dir: sortC.key === key ? (sortC.dir === 1 ? -1 : 1) : key === 'username' ? 1 : -1 };
      renderCollabs();
    });
    const body = byId('collabs-body');
    clear(body);
    const rows = sortRows(
      collabs.filter((c) => matches(`${c.username} ${c.projects.join(' ')} ${c.disabled ? 'disabled' : ''}`)),
      COLLAB_COLS,
      sortC,
    );
    byId('collabs-count').textContent = listsLoaded
      ? rows.length === collabs.length
        ? `${collabs.length}`
        : `${rows.length} of ${collabs.length}`
      : '';
    const keys = rows.map((r) => r.username);
    if (rows.length === 0) {
      const span = COLLAB_COLS.length + 1;
      body.appendChild(
        !listsLoaded
          ? emptyRow(span, 'users', 'Loading collaborators', '')
          : collabs.length === 0
            ? emptyRow(span, 'users', 'No collaborators yet', 'Create one with the form above.')
            : emptyRow(span, 'users', 'No matching collaborators', 'Try a different filter.'),
      );
      return;
    }
    for (const c of rows) {
      const slot = errSlot();
      const open = detail?.kind === 'c' && detail.key === c.username;
      body.appendChild(
        h(
          'tr',
          {
            'data-row': 'c',
            'data-key': c.username,
            'data-fk': `c:${c.username}`,
            tabindex: tabIndexFor('c', keys, c.username),
            'aria-current': open ? 'true' : null,
            class: `${open ? 'open' : ''} ${c.disabled ? 'is-disabled' : ''}`.trim(),
          },
          h('td', { class: 'mono strong nowrap' }, c.username),
          h('td', null, c.disabled ? badge('Disabled', 'destructive') : badge('Active', 'secondary')),
          h('td', null, projectLinks(c.projects)),
          h('td', { class: 'nowrap muted col-time' }, timeEl(c.created_at)),
          h(
            'td',
            { class: 'actions' },
            h(
              'div',
              { class: 'btns' },
              actionBtn('Open', `c:${c.username}:open`, () => void openDetail('c', c.username, true), `Open collaborator ${c.username}`, 'outline', 'panel-right-open'),
              actionBtn('New password', `c:${c.username}:pw`, (btn) => void regeneratePassword(c.username, slot, btn), `Regenerate password for ${c.username}`, 'ghost', 'key-round'),
              actionBtn(
                c.disabled ? 'Enable' : 'Disable',
                `c:${c.username}:toggle`,
                (btn) => void setDisabled(c.username, !c.disabled, slot, btn),
                `${c.disabled ? 'Enable' : 'Disable'} collaborator ${c.username}`,
                'ghost',
                c.disabled ? 'user-check' : 'user-x',
              ),
              actionBtn('Delete', `c:${c.username}:delete`, (btn) => void deleteCollab(c, slot, btn), `Delete collaborator ${c.username}`, 'ghost danger', 'trash-2'),
            ),
            slot,
          ),
        ),
      );
    }
  });
}

async function regeneratePassword(username: string, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  const ok = await confirmDialog(
    `Regenerate password for “${username}”?`,
    h('p', null, 'A new random password replaces the current one and ', h('strong', null, 'signs the collaborator out everywhere'), '. The new password is shown once.'),
    'Regenerate',
    false,
  );
  if (!ok) return;
  await run(slot, btn, async () => {
    const res = await api<SecretResponse>('PATCH', `/api/admin/collaborators/${enc(username)}`, { password: true });
    if (!res.password) throw new Error('The server did not return a new password');
    showSecret(res.username || username, res.password, 'regenerated');
  });
}

async function setPassword(username: string, password: string, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<boolean> {
  let done = false;
  await run(slot, btn, async () => {
    await api<SecretResponse>('PATCH', `/api/admin/collaborators/${enc(username)}`, { password });
    toast(`Password updated for ${username}. Existing sessions were signed out.`);
    done = true;
  });
  return done;
}

async function setDisabled(username: string, disabled: boolean, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  await run(slot, btn, async () => {
    await api('PATCH', `/api/admin/collaborators/${enc(username)}`, { disabled });
    await afterMutation();
    toast(`${disabled ? 'Disabled' : 'Enabled'} ${username}`);
  });
}

async function deleteCollab(c: CollabRow, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  const ok = await confirmDialog(
    `Delete collaborator “${c.username}”?`,
    h(
      'div',
      null,
      h('p', null, h('strong', null, 'All labels by this collaborator are deleted with the account'), ', in every project', c.projects.length ? ` (${c.projects.join(', ')})` : '', '.'),
      h('p', null, 'Pull their labels with quet web pull first if you still need them. To keep labels, disable the account or unassign it from the project instead.'),
    ),
    'Delete collaborator',
  );
  if (!ok) return;
  await run(slot, btn, async () => {
    await api('DELETE', `/api/admin/collaborators/${enc(c.username)}`);
    if (detail?.kind === 'c' && detail.key === c.username) closeDetail(false);
    const block = document.querySelector(`#secrets [data-user="${CSS.escape(c.username)}"]`);
    block?.remove();
    await afterMutation();
    toast(`Deleted collaborator ${c.username}`);
  });
}

/* ------------------------------------------------------------------ */
/* Secrets (credentials shown once)                                    */
/* ------------------------------------------------------------------ */

function showSecret(username: string, password: string, how: 'created' | 'regenerated'): void {
  // In sheet mode the detail panel covers (and inerts) the page, so credentials would be hidden behind it.
  if (detail && sheetMq.matches) closeDetail(false);
  const host = byId('secrets');
  for (const old of Array.from(host.children)) {
    if (old.getAttribute('data-user') === username) old.remove();
  }
  const text = `Quet labelling login\nURL: ${PUBLIC_ORIGIN}/\nUsername: ${username}\nPassword: ${password}`;
  const slot = errSlot();
  const block = h(
    'section',
    { class: 'secret', 'data-user': username, 'aria-label': `Credentials for ${username}` },
    h(
      'div',
      { class: 'secret-head' },
      icon('key-round', 'ic secret-ic'),
      h(
        'div',
        null,
        h('h3', { class: 'secret-title' }, how === 'created' ? `Collaborator “${username}” created` : `New password for “${username}”`),
        h(
          'p',
          { class: 'warning', role: 'note' },
          h('strong', null, 'Shown once. '),
          'This password cannot be retrieved later. Copy it now and send it over a private channel. If it is lost, regenerate it.',
        ),
      ),
    ),
    h('pre', { class: 'secret-block', tabindex: 0, 'aria-label': 'Credentials' }, text),
    h(
      'div',
      { class: 'btns' },
      copyButton('Copy credentials', () => text, slot, undefined, 'btn primary sm'),
      copyButton('Copy password', () => password, slot, undefined, 'btn outline sm'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost sm',
          click: () => {
            block.remove();
            byId<HTMLInputElement>('nc-username').focus();
          },
        },
        'Done, I saved it',
      ),
    ),
    slot,
  );
  host.prepend(block);
  block.querySelector<HTMLButtonElement>('button')?.focus();
  block.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* New collaborator form                                               */
/* ------------------------------------------------------------------ */

function initNewCollab(): void {
  const form = byId<HTMLFormElement>('new-collab');
  const user = byId<HTMLInputElement>('nc-username');
  const pass = byId<HTMLInputElement>('nc-password');
  const slot = byId('nc-err');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const username = user.value.trim();
    if (!USERNAME_RE.test(username)) {
      showError(slot, new Error('Invalid username: use 2 to 32 characters of a-z, 0-9, “.”, “_”, “-”, starting with a letter or digit.'));
      user.focus();
      return;
    }
    const body: { username: string; password?: string } = { username };
    if (pass.value !== '') body.password = pass.value;
    void run(slot, submit, async () => {
      const res = await api<SecretResponse>('POST', '/api/admin/collaborators', body);
      form.reset();
      clearMsg(slot);
      if (res.password) showSecret(res.username || username, res.password, 'created');
      else toast(`Collaborator “${res.username || username}” created.`);
      await afterMutation();
    });
  });
  user.addEventListener('input', () => {
    if (slot.classList.contains('has')) clearMsg(slot);
  });
}

/* ------------------------------------------------------------------ */
/* Detail panel                                                        */
/* ------------------------------------------------------------------ */

async function openDetail(kind: Kind, key: string, focusPanel: boolean): Promise<void> {
  detail = { kind, key, data: null, loading: kind === 'p', error: null };
  selected[kind] = key;
  lastKind = kind;
  const token = ++detailToken;
  history.replaceState(null, '', `#${kind === 'p' ? 'project' : 'collaborator'}/${enc(key)}`);
  renderDetail(focusPanel);
  renderProjects();
  renderCollabs();
  if (kind === 'p') await loadProjectDetail(token);
}

async function loadProjectDetail(token: number): Promise<void> {
  const d = detail;
  if (!d || d.kind !== 'p') return;
  try {
    const data = await api<ProjectDetail>('GET', `/api/admin/projects/${enc(d.key)}`);
    if (token !== detailToken || detail !== d) return;
    d.data = data;
    d.error = null;
  } catch (e) {
    if (token !== detailToken || detail !== d) return;
    d.error = e;
    d.data = null;
  }
  d.loading = false;
  renderDetail(false);
}

function closeDetail(refocus: boolean): void {
  if (!detail) return;
  const { kind, key } = detail;
  detail = null;
  detailToken++;
  history.replaceState(null, '', location.pathname + location.search);
  renderDetail(false);
  renderProjects();
  renderCollabs();
  if (refocus) {
    for (const row of document.querySelectorAll<HTMLElement>('tr[data-row]')) {
      if (row.dataset['row'] === kind && row.dataset['key'] === key) {
        row.focus();
        return;
      }
    }
  }
}

const sheetMq = window.matchMedia('(max-width: 1100px)');

/** On narrow screens the detail panel is a full-height sheet: make the page behind it inert. */
function syncSheet(): void {
  const sheet = detail !== null && sheetMq.matches;
  byId('topbar').inert = sheet;
  byId('main').inert = sheet;
}

function renderCrumbs(): void {
  const list = byId('crumbs');
  clear(list);
  const sep = (): HTMLElement => h('li', { class: 'sep', 'aria-hidden': 'true' }, icon('chevron-right'));
  if (!detail) {
    list.appendChild(h('li', null, h('span', { 'aria-current': 'page' }, 'Admin')));
    return;
  }
  list.append(
    h('li', null, h('button', { type: 'button', class: 'crumb-link', click: () => closeDetail(true) }, 'Admin')),
    sep(),
    h('li', null, detail.kind === 'p' ? 'Projects' : 'Collaborators'),
    sep(),
    h('li', { class: 'crumb-current' }, h('span', { class: 'mono', 'aria-current': 'page' }, detail.key)),
  );
}

function renderDetail(focusHeading: boolean): void {
  const panel = byId('detail');
  const app = byId('app');
  const scroll = panel.scrollTop;
  renderCrumbs();
  syncSheet();
  if (!detail) {
    panel.hidden = true;
    app.classList.remove('with-detail');
    clear(panel);
    return;
  }
  app.classList.add('with-detail');
  panel.hidden = false;
  const hadFocus = panel.contains(document.activeElement);
  withFocus(() => {
    clear(panel);
    if (!detail) return;
    panel.appendChild(detail.kind === 'p' ? projectPanel(detail) : collabPanel(detail));
  });
  panel.scrollTop = scroll;
  const lostFocus = hadFocus && !panel.contains(document.activeElement);
  const sheetNeedsFocus = sheetMq.matches && document.activeElement === document.body;
  if (focusHeading || lostFocus || sheetNeedsFocus) panel.querySelector<HTMLElement>('h2')?.focus();
}

function panelHead(title: string, sub: Child, extra: Child): HTMLElement {
  return h(
    'div',
    { class: 'panel-head' },
    h(
      'div',
      { class: 'panel-title' },
      h('h2', { tabindex: -1 }, title),
      sub ? h('div', { class: 'panel-sub' }, sub) : null,
    ),
    h(
      'div',
      { class: 'btns' },
      extra,
      h('button', { type: 'button', class: 'btn ghost icon', 'data-fk': 'detail:close', 'aria-label': 'Close panel (Esc)', title: 'Close (Esc)', click: () => closeDetail(true) }, icon('x')),
    ),
  );
}

function kv(label: string, value: Child): Node[] {
  return [h('dt', null, label), h('dd', null, value)];
}

/* ---- project panel ---- */

function projectPanel(d: DetailState): HTMLElement {
  const root = h('div', { class: 'panel' });
  const info = d.data?.project;
  const slot = errSlot();
  const url = shareUrl(d.key);

  root.appendChild(
    panelHead(
      d.key,
      info ? info.name : null,
      [
        copyButton('Copy link', () => url, slot, 'detail:copy', 'btn outline sm', `Copy shareable link for ${d.key}`),
        info
          ? actionBtn(
              'Delete',
              'detail:delete',
              (btn) => {
                const row = projects.find((p) => p.slug === d.key);
                void deleteProject(
                  row ?? { slug: d.key, name: info.name, items: info.items, proposals: info.proposals, collaborators: d.data?.collaborators.length ?? 0, created_at: info.created_at, updated_at: info.updated_at },
                  slot,
                  btn,
                );
              },
              `Delete project ${d.key}`,
              'outline danger',
              'trash-2',
            )
          : null,
      ],
    ),
  );
  root.appendChild(h('div', { class: 'panel-msg' }, slot));

  if (d.loading) {
    root.appendChild(h('p', { class: 'empty-inline' }, 'Loading…'));
    return root;
  }
  if (d.error || !d.data || !info) {
    const errBox = errSlot();
    showError(errBox, d.error ?? new Error('No data'));
    root.appendChild(h('div', { class: 'panel-msg' }, errBox));
    return root;
  }

  root.appendChild(
    h(
      'dl',
      { class: 'kv' },
      kv('Share URL', h('code', { class: 'mono' }, url)),
      kv('Items', info.items),
      kv('Proposals', info.proposals),
      kv('Created', timeEl(info.created_at)),
      kv('Updated', timeEl(info.updated_at)),
    ),
  );

  root.appendChild(proposalsToggle(d.key, info));

  root.appendChild(collaboratorsBlock(d.key, info, d.data.collaborators));
  root.appendChild(schemaBlock(info));
  return root;
}

/** Checkbox: whether collaborators see model proposals. Re-sends the loaded name/schema/YAML (PUT requires them). */
function proposalsToggle(slug: string, info: ProjectInfo): HTMLElement {
  const slot = errSlot();
  const box = h('input', { type: 'checkbox', id: 'show-proposals', 'data-fk': 'detail:show-proposals', checked: info.show_proposals });
  box.addEventListener('change', () => {
    const wanted = box.checked;
    box.disabled = true;
    void run(slot, null, async () => {
      try {
        const res = await api<{ project: { show_proposals: boolean } }>('PUT', `/api/admin/projects/${enc(slug)}`, {
          name: info.name,
          schema: info.schema,
          schema_yaml: info.schema_yaml,
          show_proposals: wanted,
        });
        info.show_proposals = res.project.show_proposals;
        box.checked = info.show_proposals;
      } catch (e) {
        box.checked = info.show_proposals;
        throw e;
      }
    }).finally(() => {
      box.disabled = false;
      if (box.isConnected) box.focus();
    });
  });
  return h('div', { class: 'toggle' }, h('label', { for: 'show-proposals' }, box, ' Show model proposals to collaborators'), slot);
}

function collaboratorsBlock(slug: string, info: ProjectInfo, rows: Progress[]): HTMLElement {
  const slot = errSlot();
  const assigned = new Set(rows.map((r) => r.username));
  const candidates = collabs.filter((c) => !assigned.has(c.username)).map((c) => c.username).sort();
  const total = info.items;

  const select = h(
    'select',
    { id: 'assign-select', class: 'select', 'aria-label': 'Collaborator to assign', disabled: candidates.length === 0 },
    candidates.length === 0 ? h('option', { value: '' }, 'no unassigned collaborators') : candidates.map((u) => h('option', { value: u }, u)),
  );
  const assignBtn = h('button', { type: 'button', class: 'btn primary', disabled: candidates.length === 0, 'data-fk': 'detail:assign' }, icon('plus'), 'Assign');
  assignBtn.addEventListener('click', () => {
    const username = select.value;
    if (!username) return;
    void run(slot, assignBtn, async () => {
      await api('PUT', `/api/admin/projects/${enc(slug)}/collaborators/${enc(username)}`);
      await afterMutation();
      toast(`Assigned ${username} to ${slug}`);
    });
  });

  const table =
    rows.length === 0
      ? h('p', { class: 'empty-inline' }, 'No collaborators assigned. Assign someone to let them label this project.')
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'compact' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, 'Collaborator'),
                h('th', { scope: 'col' }, 'Progress'),
                h('th', { scope: 'col', class: 'num', title: 'complete' }, icon('check'), h('span', { class: 'sr-only' }, 'Complete')),
                h('th', { scope: 'col', class: 'num', title: 'uncertain' }, icon('circle-help'), h('span', { class: 'sr-only' }, 'Uncertain')),
                h('th', { scope: 'col', class: 'num', title: 'skipped' }, icon('minus'), h('span', { class: 'sr-only' }, 'Skipped')),
                h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((r) => {
                const rowSlot = errSlot();
                const pct = total > 0 ? Math.round((r.labelled / total) * 100) : 0;
                return h(
                  'tr',
                  null,
                  h(
                    'td',
                    null,
                    h('button', { type: 'button', class: 'linkbtn mono', 'data-fk': `detail:u:${r.username}`, title: `Open collaborator ${r.username}`, click: () => void openDetail('c', r.username, true) }, r.username),
                    r.disabled ? [' ', badge('Disabled', 'destructive')] : null,
                    h('div', { class: 'sub' }, 'Last label: ', timeEl(r.last_label_at)),
                  ),
                  h(
                    'td',
                    { class: 'progress-cell' },
                    h('progress', { max: Math.max(total, 1), value: Math.min(r.labelled, Math.max(total, 1)), 'aria-label': `${r.username}: ${r.labelled} of ${total} labelled` }),
                    h('span', { class: 'mono' }, ` ${r.labelled}/${total}`),
                    h('span', { class: 'muted' }, ` ${pct}%`),
                  ),
                  h('td', { class: 'num mono' }, r.complete),
                  h('td', { class: 'num mono' }, r.uncertain),
                  h('td', { class: 'num mono' }, r.skipped),
                  h(
                    'td',
                    { class: 'actions' },
                    actionBtn(
                      'Unassign',
                      `detail:unassign:${r.username}`,
                      (btn) =>
                        void run(rowSlot, btn, async () => {
                          await api('DELETE', `/api/admin/projects/${enc(slug)}/collaborators/${enc(r.username)}`);
                          await afterMutation();
                          toast(`Unassigned ${r.username} from ${slug}`);
                        }),
                      `Unassign ${r.username} from ${slug} (labels are kept)`,
                      'ghost',
                      'user-minus',
                    ),
                    rowSlot,
                  ),
                );
              }),
            ),
          ),
        );

  return h(
    'section',
    { class: 'block' },
    h('h3', null, `Collaborators (${rows.length})`),
    table,
    h('div', { class: 'assign' }, h('label', { for: 'assign-select' }, 'Assign a collaborator'), select, assignBtn),
    slot,
    h('p', { class: 'hint' }, 'Unassigning hides the project from the collaborator but keeps their labels.'),
  );
}

function schemaBlock(info: ProjectInfo): HTMLElement {
  const block = h('section', { class: 'block' }, h('h3', null, 'Schema'));
  try {
    const s = info.schema;
    const nullStatuses = new Set(s.null_label_statuses);
    block.appendChild(
      h(
        'dl',
        { class: 'kv' },
        kv('Version', s.version ?? h('span', { class: 'muted' }, 'none')),
        kv('Null-label statuses', chips(s.null_label_statuses)),
        s.implicit_target ? kv('Spans', h('span', { class: 'muted' }, 'none declared (implicit single span “target”)')) : [],
      ),
    );

    block.appendChild(h('h4', null, `Types (${s.types.length})`));
    block.appendChild(
      s.types.length === 0
        ? h('p', { class: 'muted' }, 'None.')
        : miniTable(['Key', 'Name', 'Description'], s.types.map((t, i) => [i < 9 ? h('kbd', null, String(i + 1)) : '', h('span', { class: 'mono strong' }, t.name), t.description || h('span', { class: 'muted' }, 'None')])),
    );

    block.appendChild(h('h4', null, `Statuses (${s.statuses.length})`));
    block.appendChild(
      s.statuses.length === 0
        ? h('p', { class: 'muted' }, 'None.')
        : miniTable(
            ['Name', 'Description', ''],
            s.statuses.map((t) => [
              h('span', { class: 'mono strong' }, t.name),
              t.description || h('span', { class: 'muted' }, 'None'),
              nullStatuses.has(t.name) ? badge('null label', 'outline') : '',
            ]),
          ),
    );

    block.appendChild(h('h4', null, `Spans (${s.spans.length})`));
    block.appendChild(
      s.spans.length === 0
        ? h('p', { class: 'muted' }, 'None.')
        : miniTable(
            ['Name', 'Description', 'Null for types', 'Statuses'],
            s.spans.map((sp) => [h('span', { class: 'mono strong' }, sp.name), sp.description || h('span', { class: 'muted' }, 'None'), chips(sp.null_for_types), chips(sp.statuses)]),
          ),
    );
  } catch (e) {
    const slot = errSlot();
    showError(slot, new Error(`Could not render the schema: ${e instanceof Error ? e.message : String(e)}`));
    block.appendChild(slot);
  }
  if (info.schema_yaml) {
    block.appendChild(h('details', { class: 'yaml' }, h('summary', null, 'Schema YAML (as pushed)'), h('pre', { tabindex: 0 }, info.schema_yaml)));
  }
  return block;
}

function miniTable(headers: string[], rows: Child[][]): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'compact' },
      h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((cell) => h('td', null, cell))))),
    ),
  );
}

/* ---- collaborator panel ---- */

function collabPanel(d: DetailState): HTMLElement {
  const root = h('div', { class: 'panel' });
  const c = collabs.find((x) => x.username === d.key);
  const slot = errSlot();
  if (!c) {
    root.appendChild(panelHead(d.key, null, null));
    const e = errSlot();
    showError(e, new Error(listsLoaded ? 'This collaborator no longer exists.' : 'Loading…'));
    root.appendChild(h('div', { class: 'panel-msg' }, e));
    return root;
  }

  root.appendChild(
    panelHead(c.username, c.disabled ? badge('Disabled', 'destructive') : badge('Active', 'secondary'), [
      actionBtn('New password', 'detail:pw', (btn) => void regeneratePassword(c.username, slot, btn), `Regenerate password for ${c.username}`, 'outline', 'key-round'),
      actionBtn(c.disabled ? 'Enable' : 'Disable', 'detail:toggle', (btn) => void setDisabled(c.username, !c.disabled, slot, btn), `${c.disabled ? 'Enable' : 'Disable'} collaborator ${c.username}`, 'outline', c.disabled ? 'user-check' : 'user-x'),
      actionBtn('Delete', 'detail:delete', (btn) => void deleteCollab(c, slot, btn), `Delete collaborator ${c.username}`, 'outline danger', 'trash-2'),
    ]),
  );
  root.appendChild(h('div', { class: 'panel-msg' }, slot));
  root.appendChild(h('dl', { class: 'kv' }, kv('Created', timeEl(c.created_at)), kv('Login', h('code', { class: 'mono' }, `${PUBLIC_ORIGIN}/`))));

  // Assignments
  const aslot = errSlot();
  const available = projects.filter((p) => !c.projects.includes(p.slug)).map((p) => p.slug).sort();
  const select = h(
    'select',
    { id: 'assign-project', class: 'select', 'aria-label': 'Project to assign', disabled: available.length === 0 },
    available.length === 0 ? h('option', { value: '' }, 'no unassigned projects') : available.map((s) => h('option', { value: s }, s)),
  );
  const assignBtn = h('button', { type: 'button', class: 'btn primary', disabled: available.length === 0, 'data-fk': 'detail:assign' }, icon('plus'), 'Assign');
  assignBtn.addEventListener('click', () => {
    const slug = select.value;
    if (!slug) return;
    void run(aslot, assignBtn, async () => {
      await api('PUT', `/api/admin/projects/${enc(slug)}/collaborators/${enc(c.username)}`);
      await afterMutation();
      toast(`Assigned ${c.username} to ${slug}`);
    });
  });
  root.appendChild(
    h(
      'section',
      { class: 'block' },
      h('h3', null, `Assigned projects (${c.projects.length})`),
      c.projects.length === 0
        ? h('p', { class: 'empty-inline' }, 'Not assigned to any project.')
        : h(
            'ul',
            { class: 'plain' },
            c.projects.map((slug) => {
              const rowSlot = errSlot();
              return h(
                'li',
                null,
                h('button', { type: 'button', class: 'linkbtn mono', 'data-fk': `detail:p:${slug}`, click: () => void openDetail('p', slug, true) }, slug),
                actionBtn(
                  'Unassign',
                  `detail:unassign:${slug}`,
                  (btn) =>
                    void run(rowSlot, btn, async () => {
                      await api('DELETE', `/api/admin/projects/${enc(slug)}/collaborators/${enc(c.username)}`);
                      await afterMutation();
                      toast(`Unassigned ${c.username} from ${slug}`);
                    }),
                  `Unassign ${c.username} from ${slug} (labels are kept)`,
                  'ghost',
                ),
                rowSlot,
              );
            }),
          ),
      h('div', { class: 'assign' }, h('label', { for: 'assign-project' }, 'Assign to a project'), select, assignBtn),
      aslot,
    ),
  );

  // Set password
  const pslot = errSlot();
  const pw = h('input', { id: 'set-password', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'new password' });
  const pwBtn = h('button', { type: 'submit', class: 'btn outline' }, icon('key-round'), 'Set password');
  const pwForm = h('form', { class: 'assign', novalidate: true }, h('label', { for: 'set-password' }, 'Set password'), pw, pwBtn);
  pwForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!pw.value) {
      showError(pslot, new Error('Enter a password, or use “New password” to generate one.'));
      pw.focus();
      return;
    }
    void setPassword(c.username, pw.value, pslot, pwBtn).then((ok) => {
      if (ok) pw.value = '';
    });
  });
  root.appendChild(h('section', { class: 'block' }, h('h3', null, 'Password'), pwForm, pslot, h('p', { class: 'hint' }, 'Changing a password signs the collaborator out everywhere.')));
  return root;
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

function normalizeCollab(c: CollabRow): CollabRow {
  return { ...c, disabled: Boolean(c.disabled), projects: Array.isArray(c.projects) ? c.projects : [] };
}

async function reloadLists(): Promise<void> {
  const pErr = byId('projects-err');
  const cErr = byId('collabs-err');
  const [pr, cr] = await Promise.allSettled([
    api<{ projects: ProjectRow[] }>('GET', '/api/admin/projects'),
    api<{ collaborators: CollabRow[] }>('GET', '/api/admin/collaborators'),
  ]);
  if (pr.status === 'fulfilled') {
    projects = pr.value.projects;
    clearMsg(pErr);
  } else {
    showError(pErr, pr.reason);
  }
  if (cr.status === 'fulfilled') {
    collabs = cr.value.collaborators.map(normalizeCollab);
    clearMsg(cErr);
  } else {
    showError(cErr, cr.reason);
  }
  listsLoaded = true;
  renderProjects();
  renderCollabs();
  if (detail && detail.kind === 'c') renderDetail(false);
}

/** After any mutation: refresh lists and the open detail panel. */
async function afterMutation(): Promise<void> {
  await reloadLists();
  if (detail?.kind === 'p') await loadProjectDetail(detailToken);
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
}

function rowOf(t: EventTarget | null): HTMLElement | null {
  return t instanceof Element ? t.closest<HTMLElement>('tr[data-row]') : null;
}

function moveRow(delta: 1 | -1): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-row]'));
  if (rows.length === 0) return;
  let cur = rowOf(document.activeElement);
  if (!cur) {
    cur = rows.find((r) => r.dataset['row'] === lastKind && r.dataset['key'] === selected[lastKind]) ?? null;
    if (cur && document.activeElement === document.body) {
      // nothing focused: land on the remembered row first
      cur.focus();
      return;
    }
  }
  const idx = cur ? rows.indexOf(cur) : -1;
  const next = idx < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + delta));
  const el = rows[next];
  el?.focus();
  el?.scrollIntoView({ block: 'nearest' });
}

function openFocusedRow(): boolean {
  const row = document.activeElement;
  if (!(row instanceof HTMLElement) || !row.matches('tr[data-row]')) return false;
  const kind = row.dataset['row'];
  const key = row.dataset['key'];
  if ((kind === 'p' || kind === 'c') && key) {
    void openDetail(kind, key, true);
    return true;
  }
  return false;
}

function initKeyboard(): void {
  const filterEl = byId<HTMLInputElement>('filter');
  const dlg = byId<HTMLDialogElement>('confirm');

  filterEl.addEventListener('input', () => {
    filter = filterEl.value;
    renderProjects();
    renderCollabs();
  });

  document.addEventListener('focusin', (ev) => {
    const row = rowOf(ev.target);
    if (!row) return;
    const kind = row.dataset['row'];
    const key = row.dataset['key'];
    if ((kind === 'p' || kind === 'c') && key) {
      selected[kind] = key;
      lastKind = kind;
      // roving tabindex
      const body = row.parentElement;
      if (body) {
        for (const r of Array.from(body.children)) if (r instanceof HTMLElement && r.matches('tr[data-row]')) r.tabIndex = r === row ? 0 : -1;
      }
    }
  });

  // Click on a row (not on a control) opens it.
  for (const id of ['projects-body', 'collabs-body']) {
    byId(id).addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof Element) || t.closest('button, a, input, select, textarea, summary')) return;
      const row = rowOf(t);
      const kind = row?.dataset['row'];
      const key = row?.dataset['key'];
      if (row && (kind === 'p' || kind === 'c') && key) void openDetail(kind, key, false);
    });
  }

  byId('refresh').addEventListener('click', () => void afterMutation());

  document.addEventListener('keydown', (ev) => {
    if (dlg.open || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;

    if (ev.key === 'Escape') {
      if (t === filterEl && filterEl.value !== '') {
        filterEl.value = '';
        filter = '';
        renderProjects();
        renderCollabs();
        ev.preventDefault();
        return;
      }
      if (detail) {
        ev.preventDefault();
        closeDetail(true);
        return;
      }
      if (isTyping(t) && t instanceof HTMLElement) t.blur();
      return;
    }

    if (t === filterEl && (ev.key === 'Enter' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      filterEl.blur();
      lastKind = 'p';
      const first = document.querySelector<HTMLElement>('tbody tr[data-row][tabindex="0"]');
      first?.focus();
      return;
    }

    if (isTyping(t)) return;

    if (ev.key === '/') {
      ev.preventDefault();
      filterEl.focus();
      filterEl.select();
    } else if (ev.key === 'j' || (ev.key === 'ArrowDown' && rowOf(t))) {
      ev.preventDefault();
      moveRow(1);
    } else if (ev.key === 'k' || (ev.key === 'ArrowUp' && rowOf(t))) {
      ev.preventDefault();
      moveRow(-1);
    } else if (ev.key === 'Enter' && t === document.activeElement && rowOf(t) === t) {
      if (openFocusedRow()) ev.preventDefault();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function showGate(err: unknown): void {
  const gate = byId('gate');
  clear(gate);
  gate.hidden = false;
  byId('app').hidden = true;
  const status = err instanceof ApiError ? err.status : 0;
  const msg = err instanceof Error ? err.message : String(err);
  const body = h('div', { class: 'alert-body' });
  if (status === 401 || status === 403) {
    body.appendChild(h('h2', null, 'Access denied'));
    body.appendChild(
      h(
        'p',
        null,
        'The server refused this browser (HTTP ',
        String(status),
        '). The admin dashboard is protected by Cloudflare Access and only opens for the configured admin identity.',
      ),
    );
    body.appendChild(h('p', { class: 'server-msg' }, `Server said: ${msg}`));
    body.appendChild(
      h(
        'ul',
        null,
        h('li', null, 'Sign in with an account allowed by the Access policy, then reload.'),
        h('li', null, 'If you used a different account before, ', h('a', { href: '/cdn-cgi/access/logout' }, 'sign out of Access'), ' first.'),
        h('li', null, 'If this is a fresh deployment, check that ACCESS_TEAM_DOMAIN and ACCESS_AUD are set on the Worker.'),
      ),
    );
  } else {
    body.appendChild(h('h2', null, 'Cannot reach the admin API'));
    body.appendChild(h('p', { class: 'server-msg' }, msg));
  }
  body.appendChild(h('button', { type: 'button', class: 'btn outline sm', click: () => void boot() }, 'Retry'));
  gate.append(icon('shield-alert', 'ic alert-ic'), body);
}

async function boot(): Promise<void> {
  byId('gate').hidden = true;
  try {
    const who = await api<{ identity: string }>('GET', '/api/admin/whoami');
    byId('who').textContent = who.identity;
  } catch (e) {
    showGate(e);
    return;
  }
  byId('app').hidden = false;
  renderProjects();
  renderCollabs();
  await reloadLists();

  const m = /^#(project|collaborator)\/(.+)$/.exec(location.hash);
  if (m && m[1] && m[2]) {
    try {
      await openDetail(m[1] === 'project' ? 'p' : 'c', decodeURIComponent(m[2]), false);
    } catch {
      // malformed hash: ignore
    }
  }
}

function initChrome(): void {
  mountThemePicker(byId('theme-picker'));
  sheetMq.addEventListener('change', syncSheet);
  // On narrow screens the dark overlay behind the sheet is the layout's ::before; a click on it closes the panel.
  byId('app').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget && sheetMq.matches && detail) closeDetail(true);
  });
}

initChrome();
initKeyboard();
initNewCollab();
void boot();
