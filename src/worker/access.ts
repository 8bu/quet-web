import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { error } from './types';
import type { AdminVars, Env } from './types';

// Module-scope cache: one remote key set (with jose's own key caching) per team domain.
const jwksByDomain = new Map<string, JWTVerifyGetKey>();

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksByDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('https://' + teamDomain + '/cdn-cgi/access/certs'));
    jwksByDomain.set(teamDomain, jwks);
  }
  return jwks;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Verify the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header, else `CF_Authorization`
 * cookie). Returns the identity (user email or service-token common name) or null on any failure.
 *
 * `DEV_ADMIN_BYPASS=1` opens `/api/admin/*` and `/admin*` without Access. It must only ever be set
 * in `.dev.vars` (gitignored, never uploaded by `wrangler deploy`). There is deliberately no host
 * check. `wrangler.jsonc` has no route (`npm run deploy` passes the custom domain with `--domain`),
 * so `wrangler dev` keeps the local host. A `custom_domain` route in the config would make
 * `wrangler dev` rewrite `request.url` and `Host` to that domain, and a local request would then
 * look like a production one.
 */
export async function verifyAccess(request: Request, env: Env): Promise<{ identity: string } | null> {
  if (env.DEV_ADMIN_BYPASS === '1') return { identity: 'dev' };

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain || !env.ACCESS_AUD) return null;

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') || cookieValue(request.headers.get('Cookie'), 'CF_Authorization');
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: 'https://' + teamDomain,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
    const commonName = typeof payload.common_name === 'string' && payload.common_name ? payload.common_name : null;
    return { identity: email ?? commonName ?? 'unknown' };
  } catch {
    return null;
  }
}

/** Middleware: 403 JSON unless the request carries a valid Access JWT; sets `identity`. */
export const requireAccess: MiddlewareHandler<{ Bindings: Env } & AdminVars> = async (c, next) => {
  const access = await verifyAccess(c.req.raw, c.env);
  if (!access) return error('forbidden: valid Cloudflare Access credentials required', 403);
  c.set('identity', access.identity);
  await next();
};
