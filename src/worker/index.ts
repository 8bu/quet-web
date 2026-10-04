import { Hono } from 'hono';
import { requireAccess } from './access';
import { admin } from './admin';
import { collab } from './collab';
import { error } from './types';
import type { AdminVars, Env } from './types';

const CSP = "default-src 'self'; style-src 'self'; img-src 'self' data:";

const app = new Hono<{ Bindings: Env } & AdminVars>();

// Security headers on every response. Responses coming from `ASSETS.fetch` have immutable
// headers, so rebuild the response instead of mutating it.
app.use('*', async (c, next) => {
  await next();
  const res = c.res;
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  if (new URL(c.req.url).pathname.startsWith('/api/') && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }
  c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});

app.onError((err) => {
  console.error(err);
  return error('internal error', 500);
});

// Admin: Cloudflare Access JWT on every /admin* and /api/admin* request.
app.use('/api/admin/*', requireAccess);
app.use('/admin', requireAccess);
app.use('/admin/*', requireAccess);
app.use('/admin.html', requireAccess);

// A browser request that carries Access credentials must come from our own origin
// (service-token clients send no Origin header).
app.use('/api/admin/*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return error('cross-origin request refused', 403);
  }
  await next();
});

app.route('/', admin);
app.route('/', collab);
app.all('/api/*', () => error('not found', 404));

/** Fetch a static asset, following the platform's own html_handling redirects internally. */
async function asset(env: Env, requestUrl: string, path: string): Promise<Response> {
  let url = new URL(path, requestUrl);
  for (let hop = 0; hop < 4; hop++) {
    const res = await env.ASSETS.fetch(new Request(url));
    const location = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return res.status === 404 ? error('not found', 404) : res;
  }
  return error('not found', 404);
}

app.get('/admin', (c) => asset(c.env, c.req.url, '/admin.html'));
app.get('/admin/*', (c) => asset(c.env, c.req.url, '/admin.html'));
app.get('/admin.html', (c) => asset(c.env, c.req.url, '/admin.html'));
app.get('/', (c) => asset(c.env, c.req.url, '/index.html'));
app.get('/p/:slug', (c) => asset(c.env, c.req.url, '/label.html'));

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
