// Collaborator home: login form or the list of assigned projects. `GET /api/me` decides.

import { mountThemePicker } from './theme';

interface ProjectSummary {
  slug: string;
  name: string;
  items: number;
  labelled: number;
  complete: number;
  uncertain: number;
  skipped: number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const statusLine = el<HTMLElement>('status');
const loginPanel = el<HTMLElement>('login-panel');
const projectsPanel = el<HTMLElement>('projects-panel');
const loginForm = el<HTMLFormElement>('login-form');
const loginError = el<HTMLElement>('login-error');
const loginSubmit = el<HTMLButtonElement>('login-submit');
const usernameInput = el<HTMLInputElement>('username');
const passwordInput = el<HTMLInputElement>('password');
const who = el<HTMLElement>('who');
const signout = el<HTMLButtonElement>('signout');
const list = el<HTMLUListElement>('projects');
const emptyNote = el<HTMLElement>('projects-empty');
const projectsCount = el<HTMLElement>('projects-count');
const crumbs = el<HTMLElement>('crumbs');
const crumb = el<HTMLElement>('crumb');

const ICON_PATHS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  minus: '<path d="M5 12h14"/>',
} as const;
type IconName = keyof typeof ICON_PATHS;

/** Lucide icon as an inline SVG element (no innerHTML). */
function icon(name: IconName): SVGSVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`,
    'image/svg+xml',
  );
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  svg.setAttribute('class', 'ic');
  return svg;
}

/** Shows `message` in an Alert-style box (icon + text) inside `host`. */
function showAlert(host: HTMLElement, message: string): void {
  const text = document.createElement('span');
  text.textContent = message;
  host.replaceChildren(icon('circle-alert'), text);
  host.hidden = false;
}

let rows: HTMLAnchorElement[] = [];
let current = 0;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (method !== 'GET') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  return fetch(path, init);
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === 'string') return data.error;
  } catch {
    // fall through
  }
  return `request failed (${res.status})`;
}

function setStatus(message: string, isError = false): void {
  statusLine.classList.toggle('err', isError);
  if (isError) showAlert(statusLine, message);
  else statusLine.textContent = message;
  statusLine.hidden = message === '';
}

function showLogin(): void {
  setStatus('');
  projectsPanel.hidden = true;
  who.hidden = true;
  signout.hidden = true;
  crumb.textContent = 'Sign in';
  crumbs.hidden = false;
  loginPanel.hidden = false;
  passwordInput.value = '';
  (usernameInput.value === '' ? usernameInput : passwordInput).focus();
}

function showProjects(username: string): void {
  loginPanel.hidden = true;
  who.textContent = username;
  who.hidden = false;
  signout.hidden = false;
  crumb.textContent = 'Projects';
  crumbs.hidden = false;
  projectsPanel.hidden = false;
}

function highlight(index: number): void {
  if (rows.length === 0) return;
  current = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, i) => {
    const on = i === current;
    row.classList.toggle('current', on);
    if (on) {
      row.setAttribute('aria-current', 'true');
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    } else {
      row.removeAttribute('aria-current');
    }
  });
}

function textSpan(className: string, text: string, tag: 'span' | 'div' = 'span'): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function countBadge(kind: 'complete' | 'uncertain' | 'skipped', n: number): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `badge outline ${kind}`;
  badge.title = kind;
  badge.append(icon(kind === 'complete' ? 'check' : kind === 'uncertain' ? 'circle-help' : 'minus'), `${n} ${kind}`);
  return badge;
}

function renderProject(p: ProjectSummary): HTMLLIElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'project';
  a.href = `/p/${encodeURIComponent(p.slug)}`;

  const bar = document.createElement('progress');
  bar.max = Math.max(p.items, 1);
  bar.value = Math.min(p.labelled, bar.max);
  bar.setAttribute('aria-label', `${p.labelled} of ${p.items} labelled`);

  const counts = document.createElement('div');
  counts.className = 'counts';
  counts.append(countBadge('complete', p.complete), countBadge('uncertain', p.uncertain), countBadge('skipped', p.skipped));

  const pct = p.items > 0 ? Math.round((p.labelled / p.items) * 100) : 0;
  const head = document.createElement('div');
  head.className = 'project-head';
  head.append(
    textSpan('project-name', p.name),
    textSpan('project-meta', `${p.labelled}/${p.items} labelled (${pct}%)`),
  );

  a.append(head, bar, counts);
  li.append(a);
  return li;
}

async function loadProjects(): Promise<void> {
  setStatus('Loading…');
  const res = await api('GET', '/api/projects');
  if (res.status === 401) {
    showLogin();
    return;
  }
  if (!res.ok) {
    setStatus(await errorText(res), true);
    return;
  }
  const data = (await res.json()) as { projects: ProjectSummary[] };
  setStatus('');
  list.replaceChildren(...data.projects.map(renderProject));
  rows = Array.from(list.querySelectorAll<HTMLAnchorElement>('a.project'));
  emptyNote.hidden = rows.length > 0;
  projectsCount.textContent = rows.length > 0 ? String(rows.length) : '';
  current = 0;
  highlight(0);
}

async function start(): Promise<void> {
  let res: Response;
  try {
    res = await api('GET', '/api/me');
  } catch {
    setStatus('Cannot reach the server. Reload to retry.', true);
    return;
  }
  if (res.status === 401) {
    showLogin();
    return;
  }
  if (!res.ok) {
    setStatus(await errorText(res), true);
    return;
  }
  const me = (await res.json()) as { username: string };
  showProjects(me.username);
  await loadProjects();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    loginError.hidden = true;
    loginSubmit.disabled = true;
    try {
      const res = await api('POST', '/api/login', {
        username: usernameInput.value,
        password: passwordInput.value,
      });
      if (!res.ok) {
        showAlert(loginError, await errorText(res));
        passwordInput.select();
        return;
      }
      const me = (await res.json()) as { username: string };
      passwordInput.value = '';
      showProjects(me.username);
      await loadProjects();
    } catch {
      showAlert(loginError, 'Cannot reach the server');
    } finally {
      loginSubmit.disabled = false;
    }
  })();
});

signout.addEventListener('click', () => {
  void (async () => {
    signout.disabled = true;
    try {
      await api('POST', '/api/logout');
    } finally {
      signout.disabled = false;
      rows = [];
      list.replaceChildren();
      showLogin();
    }
  })();
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (projectsPanel.hidden || rows.length === 0) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, button')) return;

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      highlight(current + 1);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      highlight(current - 1);
      break;
    case 'Enter': {
      // A focused link already follows itself natively.
      if (target instanceof HTMLAnchorElement) return;
      const row = rows[current];
      if (row) {
        event.preventDefault();
        location.assign(row.href);
      }
      break;
    }
  }
});

list.addEventListener('focusin', (event) => {
  const i = rows.findIndex((row) => row === event.target);
  if (i >= 0 && i !== current) {
    current = i;
    rows.forEach((row, j) => row.classList.toggle('current', j === i));
  }
});

mountThemePicker(el<HTMLElement>('theme-picker'));
void start();
