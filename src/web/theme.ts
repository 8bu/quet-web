// Theme picker shared by every page. Choices: light, dark, system (follows prefers-color-scheme).
// public/theme-init.js applies the saved choice before first paint; this module renders the control.

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'quet-theme';

const ICONS: Record<Theme, string> = {
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  dark: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  system: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
};
const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage blocked: follow the system */
  }
  return 'system';
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

/** Renders a three-way segmented control (Light / Dark / System) into `host`. */
export function mountThemePicker(host: HTMLElement): void {
  const render = (): void => {
    const cur = getTheme();
    host.className = 'theme-picker';
    host.setAttribute('role', 'radiogroup');
    host.setAttribute('aria-label', 'Theme');
    host.innerHTML = (Object.keys(ICONS) as Theme[])
      .map(
        (t) =>
          `<button type="button" role="radio" aria-checked="${t === cur}" data-theme-choice="${t}" title="${LABEL[t]} theme" aria-label="${LABEL[t]} theme">` +
          `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[t]}</svg></button>`,
      )
      .join('');
  };
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-theme-choice]');
    if (!b) return;
    setTheme(b.dataset.themeChoice as Theme);
    render();
  });
  render();
}
