// Quet admin dashboard. Talks only to /api/admin/* (contract.md, "Admin API").
// All DOM is built with createElement/textContent: no innerHTML, no inline styles (CSP).

import type { Schema } from '../shared/schema';

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
  value: (row: T) => string | number;
}

/* ------------------------------------------------------------------ */
/* Constants & state                                                   */
/* ------------------------------------------------------------------ */

const PUBLIC_ORIGIN = 'https://quet.8bu.dev';
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
  { key: 'updated_at', label: 'Updated', value: (r) => r.updated_at },
];

const COLLAB_COLS: Col<CollabRow>[] = [
  { key: 'username', label: 'Username', value: (r) => r.username },
  { key: 'disabled', label: 'Status', value: (r) => (r.disabled ? 1 : 0) },
  { key: 'projects', label: 'Projects', value: (r) => r.projects.length },
  { key: 'created_at', label: 'Created', value: (r) => r.created_at },
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
  if (!ms || Number.isNaN(new Date(ms).getTime())) return h('span', { class: 'muted' }, '–');
  return h('time', { datetime: new Date(ms).toISOString(), title: new Date(ms).toISOString() }, fmtTime(ms));
}

function badge(text: string, cls = ''): HTMLElement {
  return h('span', { class: `badge ${cls}`.trim() }, text);
}

function chips(values: string[]): Node {
  if (values.length === 0) return h('span', { class: 'muted' }, '–');
  return h('span', { class: 'chips' }, values.map((v) => h('span', { class: 'chip' }, v)));
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
    return [head.join(' / '), ...rest].filter(Boolean).join(' – ');
  }
  return JSON.stringify(item);
}

/** Render an error (message + any list members such as the 409 `invalid` list) into `slot`. */
function showError(slot: HTMLElement, err: unknown): void {
  clear(slot);
  slot.classList.remove('ok');
  slot.classList.add('has');
  const msg = err instanceof Error ? err.message : String(err);
  slot.appendChild(h('span', { class: 'msg' }, msg));
  if (err instanceof ApiError) {
    for (const [key, value] of Object.entries(err.body)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const label = key === 'invalid' ? `Invalid (${value.length}${value.length >= 50 ? '+' : ''})` : key;
      slot.appendChild(
        h(
          'details',
          { class: 'err-list', open: true },
          h('summary', null, label),
          h('ul', null, value.map((item) => h('li', null, describeItem(item)))),
        ),
      );
    }
  }
}

function showOk(slot: HTMLElement, msg: string): void {
  clear(slot);
  slot.classList.add('has', 'ok');
  slot.appendChild(h('span', { class: 'msg' }, msg));
}

function clearMsg(slot: HTMLElement): void {
  clear(slot);
  slot.classList.remove('has', 'ok');
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

function copyButton(label: string, getText: () => string, slot: HTMLElement, fk?: string, extra = '', aria?: string): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: extra, 'data-fk': fk, 'aria-label': aria, title: aria }, label);
  let timer = 0;
  btn.addEventListener('click', () => {
    void copyText(getText()).then(
      () => {
        clearMsg(slot);
        btn.textContent = 'Copied ✓';
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          btn.textContent = label;
        }, 1600);
      },
      (e: unknown) => showError(slot, e),
    );
  });
  return btn;
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

function confirmDialog(title: string, body: Child, okLabel: string): Promise<boolean> {
  const dlg = byId<HTMLDialogElement>('confirm');
  byId('confirm-title').textContent = title;
  const bodyEl = byId('confirm-body');
  clear(bodyEl);
  appendKids(bodyEl, [body]);
  byId<HTMLButtonElement>('confirm-ok').textContent = okLabel;
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
            class: c.num ? 'num' : '',
            'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none',
          },
          h(
            'button',
            { type: 'button', class: 'sort', 'data-fk': `sort:${tableId}:${c.key}`, click: () => onSort(c.key) },
            c.label,
            active ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, sort.dir === 1 ? '▲' : '▼') : null,
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
  cls = '',
): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: `act ${cls}`.trim(), 'data-fk': fk, 'aria-label': aria }, label);
  btn.addEventListener('click', () => onClick(btn));
  return btn;
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
      body.appendChild(
        h(
          'tr',
          { class: 'empty' },
          h(
            'td',
            { colspan: PROJECT_COLS.length + 1 },
            !listsLoaded ? 'Loading…' : projects.length === 0 ? 'No projects yet. Push one with quet web push.' : 'No projects match the filter.',
          ),
        ),
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
          h('td', { class: 'mono strong' }, p.slug),
          h('td', null, p.name),
          h('td', { class: 'num' }, p.items),
          h('td', { class: 'num' }, p.proposals),
          h('td', { class: 'num' }, p.collaborators),
          h('td', { class: 'nowrap' }, timeEl(p.updated_at)),
          h(
            'td',
            { class: 'actions' },
            h(
              'div',
              { class: 'btns' },
              actionBtn('Open', `p:${p.slug}:open`, () => void openDetail('p', p.slug, true), `Open project ${p.slug}`),
              copyButton('Copy link', () => shareUrl(p.slug), slot, `p:${p.slug}:copy`, 'act', `Copy shareable link for ${p.slug}`),
              actionBtn('Delete', `p:${p.slug}:delete`, (btn) => void deleteProject(p, slot, btn), `Delete project ${p.slug}`, 'danger'),
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
      h('p', { class: 'muted' }, 'Pulled labels in Quet files are not affected. This cannot be undone.'),
    ),
    'Delete project',
  );
  if (!ok) return;
  await run(slot, btn, async () => {
    await api('DELETE', `/api/admin/projects/${enc(p.slug)}`);
    if (detail?.kind === 'p' && detail.key === p.slug) closeDetail(false);
    await reloadLists();
  });
}

/* ------------------------------------------------------------------ */
/* Collaborators table                                                 */
/* ------------------------------------------------------------------ */

function projectLinks(slugs: string[]): Node {
  if (slugs.length === 0) return h('span', { class: 'muted' }, '–');
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
      body.appendChild(
        h(
          'tr',
          { class: 'empty' },
          h(
            'td',
            { colspan: COLLAB_COLS.length + 1 },
            !listsLoaded ? 'Loading…' : collabs.length === 0 ? 'No collaborators yet. Create one above.' : 'No collaborators match the filter.',
          ),
        ),
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
          h('td', { class: 'mono strong' }, c.username),
          h('td', null, c.disabled ? badge('disabled', 'warn') : h('span', { class: 'muted' }, 'active')),
          h('td', null, projectLinks(c.projects)),
          h('td', { class: 'nowrap' }, timeEl(c.created_at)),
          h(
            'td',
            { class: 'actions' },
            h(
              'div',
              { class: 'btns' },
              actionBtn('Open', `c:${c.username}:open`, () => void openDetail('c', c.username, true), `Open collaborator ${c.username}`),
              actionBtn('New password', `c:${c.username}:pw`, (btn) => void regeneratePassword(c.username, slot, btn), `Regenerate password for ${c.username}`),
              actionBtn(
                c.disabled ? 'Enable' : 'Disable',
                `c:${c.username}:toggle`,
                (btn) => void setDisabled(c.username, !c.disabled, slot, btn),
                `${c.disabled ? 'Enable' : 'Disable'} collaborator ${c.username}`,
              ),
              actionBtn('Delete', `c:${c.username}:delete`, (btn) => void deleteCollab(c, slot, btn), `Delete collaborator ${c.username}`, 'danger'),
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
    showOk(slot, 'Password updated; existing sessions were signed out.');
    done = true;
  });
  return done;
}

async function setDisabled(username: string, disabled: boolean, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  await run(slot, btn, async () => {
    await api('PATCH', `/api/admin/collaborators/${enc(username)}`, { disabled });
    await afterMutation();
  });
}

async function deleteCollab(c: CollabRow, slot: HTMLElement, btn: HTMLButtonElement | null): Promise<void> {
  const ok = await confirmDialog(
    `Delete collaborator “${c.username}”?`,
    h(
      'div',
      null,
      h('p', null, h('strong', null, 'All labels by this collaborator are deleted with the account'), ', in every project', c.projects.length ? ` (${c.projects.join(', ')})` : '', '.'),
      h('p', { class: 'muted' }, 'Pull their labels with quet web pull first if you still need them. To keep labels, disable the account or unassign it from the project instead.'),
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
  });
}

/* ------------------------------------------------------------------ */
/* Secrets (credentials shown once)                                    */
/* ------------------------------------------------------------------ */

function showSecret(username: string, password: string, how: 'created' | 'regenerated'): void {
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
      h('strong', null, how === 'created' ? `Collaborator “${username}” created` : `New password for “${username}”`),
    ),
    h(
      'p',
      { class: 'warning', role: 'note' },
      h('strong', null, 'Shown once. '),
      'This password cannot be retrieved later. Copy it now and send it over a private channel. If it is lost, regenerate it.',
    ),
    h('pre', { class: 'secret-block', tabindex: 0, 'aria-label': 'Credentials' }, text),
    h(
      'div',
      { class: 'btns' },
      copyButton('Copy credentials', () => text, slot, undefined, 'primary'),
      copyButton('Copy password', () => password, slot),
      h(
        'button',
        {
          type: 'button',
          click: () => {
            block.remove();
            byId<HTMLInputElement>('nc-username').focus();
          },
        },
        'Done – I saved it',
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
      showError(slot, new Error('Invalid username: use 2–32 characters of a–z, 0–9, “.”, “_”, “-”, starting with a letter or digit.'));
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
      else showOk(slot, `Collaborator “${res.username || username}” created.`);
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

function renderDetail(focusHeading: boolean): void {
  const panel = byId('detail');
  const app = byId('app');
  const scroll = panel.scrollTop;
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
  if (focusHeading || (hadFocus && !panel.contains(document.activeElement))) panel.querySelector<HTMLElement>('h2')?.focus();
}

function panelHead(title: string, sub: Child, extra: Child): HTMLElement {
  return h(
    'div',
    { class: 'panel-head' },
    h(
      'div',
      { class: 'panel-title' },
      h('h2', { tabindex: -1 }, title),
      sub ? h('div', { class: 'muted' }, sub) : null,
    ),
    h(
      'div',
      { class: 'btns' },
      extra,
      h('button', { type: 'button', 'data-fk': 'detail:close', 'aria-label': 'Close panel (Esc)', title: 'Close (Esc)', click: () => closeDetail(true) }, 'Close ✕'),
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
        copyButton('Copy link', () => url, slot, 'detail:copy', '', `Copy shareable link for ${d.key}`),
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
              'danger',
            )
          : null,
      ],
    ),
  );
  root.appendChild(slot);

  if (d.loading) {
    root.appendChild(h('p', { class: 'muted' }, 'Loading…'));
    return root;
  }
  if (d.error || !d.data || !info) {
    const errBox = errSlot();
    showError(errBox, d.error ?? new Error('No data'));
    root.appendChild(errBox);
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
    { id: 'assign-select', 'aria-label': 'Collaborator to assign', disabled: candidates.length === 0 },
    candidates.length === 0 ? h('option', { value: '' }, 'no unassigned collaborators') : candidates.map((u) => h('option', { value: u }, u)),
  );
  const assignBtn = h('button', { type: 'button', class: 'primary', disabled: candidates.length === 0, 'data-fk': 'detail:assign' }, 'Assign');
  assignBtn.addEventListener('click', () => {
    const username = select.value;
    if (!username) return;
    void run(slot, assignBtn, async () => {
      await api('PUT', `/api/admin/projects/${enc(slug)}/collaborators/${enc(username)}`);
      await afterMutation();
    });
  });

  const table =
    rows.length === 0
      ? h('p', { class: 'muted' }, 'No collaborators assigned. Assign someone to let them label this project.')
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
                h('th', { scope: 'col', class: 'num', title: 'complete' }, '✓'),
                h('th', { scope: 'col', class: 'num', title: 'uncertain' }, '?'),
                h('th', { scope: 'col', class: 'num', title: 'skipped' }, '–'),
                h('th', { scope: 'col' }, 'Last label'),
                h('th', { scope: 'col' }, ''),
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
                    ' ',
                    r.disabled ? badge('disabled', 'warn') : null,
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
                  h('td', { class: 'nowrap' }, timeEl(r.last_label_at)),
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
                        }),
                      `Unassign ${r.username} from ${slug} (labels are kept)`,
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
    h('div', { class: 'assign' }, h('label', { for: 'assign-select' }, 'Assign'), select, assignBtn),
    slot,
    h('p', { class: 'hint muted' }, 'Unassigning hides the project from the collaborator but keeps their labels.'),
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
        : miniTable(['Key', 'Name', 'Description'], s.types.map((t, i) => [i < 9 ? String(i + 1) : '', h('span', { class: 'mono strong' }, t.name), t.description || h('span', { class: 'muted' }, '–')])),
    );

    block.appendChild(h('h4', null, `Statuses (${s.statuses.length})`));
    block.appendChild(
      s.statuses.length === 0
        ? h('p', { class: 'muted' }, 'None.')
        : miniTable(
            ['Name', 'Description', ''],
            s.statuses.map((t) => [
              h('span', { class: 'mono strong' }, t.name),
              t.description || h('span', { class: 'muted' }, '–'),
              nullStatuses.has(t.name) ? badge('null label', 'info') : '',
            ]),
          ),
    );

    block.appendChild(h('h4', null, `Spans (${s.spans.length})`));
    block.appendChild(
      s.spans.length === 0
        ? h('p', { class: 'muted' }, 'None.')
        : miniTable(
            ['Name', 'Description', 'Null for types', 'Statuses'],
            s.spans.map((sp) => [h('span', { class: 'mono strong' }, sp.name), sp.description || h('span', { class: 'muted' }, '–'), chips(sp.null_for_types), chips(sp.statuses)]),
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
    root.appendChild(e);
    return root;
  }

  root.appendChild(
    panelHead(c.username, c.disabled ? badge('disabled', 'warn') : 'active', [
      actionBtn('New password', 'detail:pw', (btn) => void regeneratePassword(c.username, slot, btn), `Regenerate password for ${c.username}`),
      actionBtn(c.disabled ? 'Enable' : 'Disable', 'detail:toggle', (btn) => void setDisabled(c.username, !c.disabled, slot, btn), `${c.disabled ? 'Enable' : 'Disable'} collaborator ${c.username}`),
      actionBtn('Delete', 'detail:delete', (btn) => void deleteCollab(c, slot, btn), `Delete collaborator ${c.username}`, 'danger'),
    ]),
  );
  root.appendChild(slot);
  root.appendChild(h('dl', { class: 'kv' }, kv('Created', timeEl(c.created_at)), kv('Login', h('code', { class: 'mono' }, `${PUBLIC_ORIGIN}/`))));

  // Assignments
  const aslot = errSlot();
  const available = projects.filter((p) => !c.projects.includes(p.slug)).map((p) => p.slug).sort();
  const select = h(
    'select',
    { id: 'assign-project', 'aria-label': 'Project to assign', disabled: available.length === 0 },
    available.length === 0 ? h('option', { value: '' }, 'no unassigned projects') : available.map((s) => h('option', { value: s }, s)),
  );
  const assignBtn = h('button', { type: 'button', class: 'primary', disabled: available.length === 0, 'data-fk': 'detail:assign' }, 'Assign');
  assignBtn.addEventListener('click', () => {
    const slug = select.value;
    if (!slug) return;
    void run(aslot, assignBtn, async () => {
      await api('PUT', `/api/admin/projects/${enc(slug)}/collaborators/${enc(c.username)}`);
      await afterMutation();
    });
  });
  root.appendChild(
    h(
      'section',
      { class: 'block' },
      h('h3', null, `Assigned projects (${c.projects.length})`),
      c.projects.length === 0
        ? h('p', { class: 'muted' }, 'Not assigned to any project.')
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
                    }),
                  `Unassign ${c.username} from ${slug} (labels are kept)`,
                ),
                rowSlot,
              );
            }),
          ),
      h('div', { class: 'assign' }, h('label', { for: 'assign-project' }, 'Assign to'), select, assignBtn),
      aslot,
    ),
  );

  // Set password
  const pslot = errSlot();
  const pw = h('input', { id: 'set-password', type: 'password', autocomplete: 'new-password', placeholder: 'new password' });
  const pwBtn = h('button', { type: 'submit' }, 'Set password');
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
  root.appendChild(h('section', { class: 'block' }, h('h3', null, 'Password'), pwForm, pslot, h('p', { class: 'hint muted' }, 'Changing a password signs the collaborator out everywhere.')));
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
  if (status === 401 || status === 403) {
    gate.appendChild(h('h2', null, 'Access denied'));
    gate.appendChild(
      h(
        'p',
        null,
        'The server refused this browser (HTTP ',
        String(status),
        '). The admin dashboard is protected by Cloudflare Access and only opens for the configured admin identity.',
      ),
    );
    gate.appendChild(h('p', { class: 'server-msg' }, `Server said: ${msg}`));
    gate.appendChild(
      h(
        'ul',
        null,
        h('li', null, 'Sign in with an account allowed by the Access policy, then reload.'),
        h('li', null, 'If you used a different account before, ', h('a', { href: '/cdn-cgi/access/logout' }, 'sign out of Access'), ' first.'),
        h('li', null, 'If this is a fresh deployment, check that ACCESS_TEAM_DOMAIN and ACCESS_AUD are set on the Worker.'),
      ),
    );
  } else {
    gate.appendChild(h('h2', null, 'Cannot reach the admin API'));
    gate.appendChild(h('p', { class: 'server-msg' }, msg));
  }
  gate.appendChild(h('button', { type: 'button', click: () => void boot() }, 'Retry'));
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

initKeyboard();
initNewCollab();
void boot();
