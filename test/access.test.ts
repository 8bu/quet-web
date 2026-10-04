import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireAccess, verifyAccess } from '../src/worker/access';
import type { AdminVars, Env } from '../src/worker/types';

/**
 * The Access gate is the only thing protecting the admin surface in production, so pin its
 * fail-closed behaviour here: no credentials must never mean access, and the dev bypass must open
 * the gate only for the exact value "1".
 */
const env = (over: Partial<Env> = {}): Env =>
  ({
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-tag',
    ...over,
  }) as unknown as Env;

const request = (headers: Record<string, string> = {}): Request =>
  new Request('https://quet.8bu.dev/api/admin/whoami', { headers });

describe('verifyAccess', () => {
  it('accepts exactly DEV_ADMIN_BYPASS=1 and reports the dev identity', async () => {
    expect(await verifyAccess(request(), env({ DEV_ADMIN_BYPASS: '1' }))).toEqual({ identity: 'dev' });
  });

  it('fails closed for any other bypass value', async () => {
    for (const value of ['true', 'yes', '0', '', ' 1', '2']) {
      expect(await verifyAccess(request(), env({ DEV_ADMIN_BYPASS: value }))).toBeNull();
    }
    expect(await verifyAccess(request(), env())).toBeNull();
  });

  it('refuses a request with no Access credentials', async () => {
    expect(await verifyAccess(request(), env())).toBeNull();
  });

  it('refuses a malformed assertion header, a malformed cookie and an empty token', async () => {
    expect(await verifyAccess(request({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }), env())).toBeNull();
    expect(await verifyAccess(request({ 'Cf-Access-Jwt-Assertion': '' }), env())).toBeNull();
    expect(await verifyAccess(request({ cookie: 'CF_Authorization=not-a-jwt' }), env())).toBeNull();
    expect(await verifyAccess(request({ cookie: 'other=1; CF_Authorization=not-a-jwt' }), env())).toBeNull();
  });

  it('refuses when the team domain or audience is not configured', async () => {
    const withToken = request({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' });
    expect(await verifyAccess(withToken, env({ ACCESS_TEAM_DOMAIN: '' }))).toBeNull();
    expect(await verifyAccess(withToken, env({ ACCESS_AUD: '' }))).toBeNull();
  });
});

describe('requireAccess middleware', () => {
  const app = new Hono<{ Bindings: Env } & AdminVars>();
  app.use('/api/admin/*', requireAccess);
  app.get('/api/admin/whoami', (c) => c.json({ identity: c.get('identity') }));

  it('lets a bypassed dev request through and sets the identity', async () => {
    const res = await app.request('/api/admin/whoami', {}, env({ DEV_ADMIN_BYPASS: '1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: 'dev' });
  });

  it('answers 403 JSON without credentials', async () => {
    const res = await app.request('/api/admin/whoami', {}, env());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: valid Cloudflare Access credentials required' });
  });

  it('answers 403 with a malformed token and with a non-1 bypass', async () => {
    const malformed = await app.request('/api/admin/whoami', { headers: { 'Cf-Access-Jwt-Assertion': 'nope' } }, env());
    expect(malformed.status).toBe(403);
    const truthy = await app.request('/api/admin/whoami', {}, env({ DEV_ADMIN_BYPASS: 'true' }));
    expect(truthy.status).toBe(403);
  });
});
