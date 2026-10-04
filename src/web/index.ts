// Collaborator home: login form or the list of assigned projects. `GET /api/me` decides.

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
  statusLine.textContent = message;
  statusLine.classList.toggle('err', isError);
  statusLine.hidden = message === '';
}

function showLogin(): void {
  setStatus('');
  projectsPanel.hidden = true;
  who.hidden = true;
  signout.hidden = true;
  loginPanel.hidden = false;
  passwordInput.value = '';
  (usernameInput.value === '' ? usernameInput : passwordInput).focus();
}

function showProjects(username: string): void {
  loginPanel.hidden = true;
  who.textContent = username;
  who.hidden = false;
  signout.hidden = false;
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
  counts.append(
    textSpan('complete', `✓ ${p.complete}`),
    textSpan('uncertain', `? ${p.uncertain}`),
    textSpan('skipped', `– ${p.skipped}`),
  );

  a.append(
    textSpan('project-name', p.name),
    textSpan('project-meta', `${p.labelled}/${p.items} labelled · ${p.items} items`),
    bar,
    counts,
  );
  li.append(a);
  return li;
}

async function loadProjects(): Promise<void> {
  setStatus('loading…');
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
  current = 0;
  highlight(0);
}

async function start(): Promise<void> {
  let res: Response;
  try {
    res = await api('GET', '/api/me');
  } catch {
    setStatus('cannot reach the server — reload to retry', true);
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
        loginError.textContent = await errorText(res);
        loginError.hidden = false;
        passwordInput.select();
        return;
      }
      const me = (await res.json()) as { username: string };
      passwordInput.value = '';
      showProjects(me.username);
      await loadProjects();
    } catch {
      loginError.textContent = 'cannot reach the server';
      loginError.hidden = false;
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

void start();
