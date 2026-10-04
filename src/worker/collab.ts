import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { normalizeLabel, parseSchema, validateLabel } from '../shared/schema';
import type { Label, Schema } from '../shared/schema';
import { generateSessionToken, sha256Hex, verifyPassword } from './pw';
import { error, json } from './types';
import type { CollabVars, CollaboratorRow, Env } from './types';

type E = { Bindings: Env } & CollabVars;
type Ctx = Context<E>;

const COOKIE = 'quet_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
const MAX_BODY_CHARS = 256 * 1024;
const MAX_LIMIT = 1000;

export const collab = new Hono<E>();

// ---------------------------------------------------------------------------
// helpers

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

type JsonObject = Record<string, unknown>;

/** Parsed JSON body, or the ready error response. */
type Body = { ok: true; value: JsonObject } | { ok: false; res: Response };

async function readJsonBody(c: Ctx): Promise<Body> {
  const text = await c.req.text();
  if (text.length > MAX_BODY_CHARS) return { ok: false, res: error('request body too large', 413) };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, res: error('request body must be valid JSON', 400) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, res: error('request body must be a JSON object', 400) };
  }
  return { ok: true, value: value as JsonObject };
}

// ---------------------------------------------------------------------------
// middleware

/** Mutating requests: JSON content type and, when sent, a same-origin Origin header. */
const guardMutations: MiddlewareHandler<E> = async (c, next) => {
  const method = c.req.method;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      return error('Content-Type must be application/json', 400);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return error('cross-origin request rejected', 403);
    }
  }
  await next();
};

const auth: MiddlewareHandler<E> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token || token.length > 128) return error('not signed in', 401);
  const row = await c.env.DB.prepare(
    `SELECT s.collaborator_id AS collaborator_id, c.username AS username
       FROM sessions s JOIN collaborators c ON c.id = s.collaborator_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND c.disabled = 0`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<{ collaborator_id: number; username: string }>();
  if (!row) return error('not signed in', 401);
  c.set('collaboratorId', row.collaborator_id);
  c.set('username', row.username);
  await next();
};

// ---------------------------------------------------------------------------
// project access

interface AssignedProject {
  id: number;
  slug: string;
  name: string;
  schema_json: string;
  show_proposals: number;
}

/** The project iff it is assigned to this collaborator. */
async function assignedProject(c: Ctx, slug: string): Promise<AssignedProject | null> {
  return c.env.DB.prepare(
    `SELECT p.id AS id, p.slug AS slug, p.name AS name, p.schema_json AS schema_json, p.show_proposals AS show_proposals
       FROM projects p JOIN assignments a ON a.project_id = p.id
      WHERE p.slug = ?1 AND a.collaborator_id = ?2`,
  )
    .bind(slug, c.get('collaboratorId'))
    .first<AssignedProject>();
}

function schemaOf(project: AssignedProject): Schema {
  return parseSchema(JSON.parse(project.schema_json));
}

// ---------------------------------------------------------------------------
// auth routes

collab.post('/api/login', guardMutations, async (c) => {
  const body = await readJsonBody(c);
  if (!body.ok) return body.res;
  const { username, password } = body.value;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return error('username and password are required', 400);
  }
  const invalid = () => error('invalid username or password', 401);
  if (password.length === 0 || password.length > 1024) return invalid();

  const user = await c.env.DB.prepare(
    `SELECT id, username, password_hash, password_salt, password_iterations, disabled
       FROM collaborators WHERE username = ?1`,
  )
    .bind(username.trim().toLowerCase())
    .first<CollaboratorRow>();
  if (!user || user.disabled !== 0) return invalid();
  if (!(await verifyPassword(password, user))) return invalid();

  const token = generateSessionToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    c.env.DB.prepare(
      'INSERT INTO sessions (token_hash, collaborator_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(await sha256Hex(token), user.id, now + SESSION_TTL_S * 1000, now),
  ]);
  return json({ username: user.username }, 200, {
    'set-cookie': sessionCookie(token, SESSION_TTL_S),
    'cache-control': 'no-store',
  });
});

collab.post('/api/logout', guardMutations, auth, async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0), 'cache-control': 'no-store' });
});

collab.get('/api/me', auth, (c) => json({ username: c.get('username') }, 200, { 'cache-control': 'no-store' }));

// ---------------------------------------------------------------------------
// projects

collab.get('/api/projects', auth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.slug AS slug, p.name AS name,
            (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id) AS items,
            (SELECT COUNT(*) FROM labels l
              WHERE l.project_id = p.id AND l.collaborator_id = ?1) AS labelled,
            (SELECT COUNT(*) FROM labels l
              WHERE l.project_id = p.id AND l.collaborator_id = ?1 AND l.annotation_status = 'complete') AS complete,
            (SELECT COUNT(*) FROM labels l
              WHERE l.project_id = p.id AND l.collaborator_id = ?1 AND l.annotation_status = 'uncertain') AS uncertain,
            (SELECT COUNT(*) FROM labels l
              WHERE l.project_id = p.id AND l.collaborator_id = ?1 AND l.annotation_status = 'skipped') AS skipped
       FROM projects p JOIN assignments a ON a.project_id = p.id AND a.collaborator_id = ?1
      ORDER BY p.name COLLATE NOCASE, p.slug`,
  )
    .bind(c.get('collaboratorId'))
    .all();
  return json({ projects: results }, 200, { 'cache-control': 'no-store' });
});

collab.get('/api/projects/:slug', auth, async (c) => {
  const project = await assignedProject(c, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE project_id = ?1')
    .bind(project.id)
    .first<{ n: number }>();
  return json(
    {
      project: {
        slug: project.slug,
        name: project.name,
        schema: schemaOf(project),
        show_proposals: project.show_proposals !== 0,
        items: count?.n ?? 0,
      },
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

function intParam(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

collab.get('/api/projects/:slug/items', auth, async (c) => {
  const offset = intParam(c.req.query('offset'), 0);
  const limit = intParam(c.req.query('limit'), MAX_LIMIT);
  if (offset === null) return error('offset must be a non-negative integer', 400);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return error(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  const project = await assignedProject(c, c.req.param('slug'));
  if (!project) return error('project not found', 404);

  const db = c.env.DB;
  const [page, total] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT i.item_id AS item_id, i.position AS position, i.text AS text,
                pr.proposal_json AS proposal_json, l.label_json AS label_json
           FROM items i
           LEFT JOIN proposals pr ON pr.project_id = i.project_id AND pr.item_id = i.item_id
           LEFT JOIN labels l ON l.project_id = i.project_id AND l.item_id = i.item_id
                              AND l.collaborator_id = ?2
          WHERE i.project_id = ?1
          ORDER BY i.position, i.item_id
          LIMIT ?3 OFFSET ?4`,
      )
      .bind(project.id, c.get('collaboratorId'), limit, offset),
    db.prepare('SELECT COUNT(*) AS n FROM items WHERE project_id = ?1').bind(project.id),
  ]);
  const items = (page?.results ?? []).map((r) => ({
    id: r['item_id'],
    position: r['position'],
    text: r['text'],
    proposal: typeof r['proposal_json'] === 'string' ? (JSON.parse(r['proposal_json']) as unknown) : null,
    label: typeof r['label_json'] === 'string' ? (JSON.parse(r['label_json']) as unknown) : null,
  }));
  const n = total?.results[0]?.['n'];
  return json({ items, total: typeof n === 'number' ? n : 0 }, 200, { 'cache-control': 'no-store' });
});

// ---------------------------------------------------------------------------
// labels

collab.put('/api/projects/:slug/labels/:item_id', guardMutations, auth, async (c) => {
  const body = await readJsonBody(c);
  if (!body.ok) return body.res;
  const rawLabel = body.value['label'];
  if (typeof rawLabel !== 'object' || rawLabel === null || Array.isArray(rawLabel)) {
    return error('label must be a JSON object', 400);
  }
  const raw = rawLabel as JsonObject;

  const project = await assignedProject(c, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const itemId = c.req.param('item_id');
  const item = await c.env.DB.prepare('SELECT text FROM items WHERE project_id = ?1 AND item_id = ?2')
    .bind(project.id, itemId)
    .first<{ text: string }>();
  if (!item) return error('item not found', 404);

  if (raw['id'] !== itemId) return error(`label id must be "${itemId}"`, 400);

  const schema = schemaOf(project);
  let normalized: Label;
  try {
    normalized = normalizeLabel(schema, raw as Label);
  } catch {
    return error('invalid label', 400);
  }
  const checked = validateLabel(schema, item.text, normalized);
  if (!checked.ok) return error(checked.error, 400);
  const saved = checked.label;
  if (saved.id !== itemId) return error(`label id must be "${itemId}"`, 400);

  await c.env.DB.prepare(
    `INSERT INTO labels (project_id, item_id, collaborator_id, label_json, annotation_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (project_id, item_id, collaborator_id) DO UPDATE SET
       label_json = excluded.label_json,
       annotation_status = excluded.annotation_status,
       updated_at = excluded.updated_at`,
  )
    .bind(project.id, itemId, c.get('collaboratorId'), JSON.stringify(saved), saved.annotation_status, Date.now())
    .run();
  return json({ label: saved });
});

collab.delete('/api/projects/:slug/labels/:item_id', guardMutations, auth, async (c) => {
  const project = await assignedProject(c, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  await c.env.DB.prepare('DELETE FROM labels WHERE project_id = ?1 AND item_id = ?2 AND collaborator_id = ?3')
    .bind(project.id, c.req.param('item_id'), c.get('collaboratorId'))
    .run();
  return json({ deleted: true });
});
