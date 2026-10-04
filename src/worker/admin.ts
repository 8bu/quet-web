import { Hono } from 'hono';
import { SchemaError, parseSchema, validateLabel } from '../shared/schema';
import type { Schema } from '../shared/schema';
import { generatePassword, hashPassword } from './pw';
import { error, json } from './types';
import type { AdminVars, CollaboratorRow, Env, ProjectRow } from './types';
import { chunk, isRecord, now, parseProject, rowToProject, validSlug, validUsername } from './util';

/** Admin API (`/api/admin/*`). Access gating is applied by the app in `index.ts`. */
export const admin = new Hono<{ Bindings: Env } & AdminVars>();

/** Per-call cap for items / proposals pushes. */
const MAX_PER_CALL = 1000;
/** Statements per `D1Database.batch()`. */
const BATCH_SIZE = 50;
/** Rows per page when re-validating stored labels. */
const LABEL_PAGE = 500;
/** Max invalid labels listed in a schema-change 409. */
const MAX_INVALID = 50;

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('request body must be valid JSON', 400);
  }
  if (!isRecord(body)) return error('request body must be a JSON object', 400);
  return body;
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const part of chunk(statements, BATCH_SIZE)) await db.batch(part);
}

/** Parse an unsigned integer query param; `undefined` → fallback, junk → null, above max → max. */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n < min ? null : Math.min(n, max);
}

/** `show_proposals` is stored as 0/1 (migration 0002). */
type WithShowProposals = { show_proposals: number };

function findProject(db: D1Database, slug: string): Promise<(ProjectRow & WithShowProposals) | null> {
  return db.prepare('SELECT * FROM projects WHERE slug = ?1').bind(slug).first<ProjectRow & WithShowProposals>();
}

interface Counts {
  items: number;
  proposals: number;
  collaborators: number;
}

async function projectCounts(db: D1Database, projectId: number): Promise<Counts> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM items WHERE project_id = ?1) AS items,
              (SELECT COUNT(*) FROM proposals WHERE project_id = ?1) AS proposals,
              (SELECT COUNT(*) FROM assignments WHERE project_id = ?1) AS collaborators`,
    )
    .bind(projectId)
    .first<Counts>();
  return row ?? { items: 0, proposals: 0, collaborators: 0 };
}

// ---------------------------------------------------------------------------------------------
// whoami

admin.get('/api/admin/whoami', (c) => json({ identity: c.get('identity') }));

// ---------------------------------------------------------------------------------------------
// projects

admin.get('/api/admin/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.slug, p.name, p.show_proposals, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id) AS items,
            (SELECT COUNT(*) FROM proposals q WHERE q.project_id = p.id) AS proposals,
            (SELECT COUNT(*) FROM assignments a WHERE a.project_id = p.id) AS collaborators
     FROM projects p ORDER BY p.slug`,
  ).all<Pick<ProjectRow, 'slug' | 'name' | 'created_at' | 'updated_at'> & WithShowProposals & Counts>();
  return json({
    projects: results.map((r) => ({ ...rowToProject(r, r), show_proposals: r.show_proposals !== 0 })),
  });
});

interface InvalidLabel {
  collaborator: string;
  id: string;
  error: string;
}

/** Re-validate every stored label of a project against `schema` and its item text (first 50 failures). */
async function findInvalidLabels(db: D1Database, projectId: number, schema: Schema): Promise<InvalidLabel[]> {
  const invalid: InvalidLabel[] = [];
  let afterItem = '';
  let afterCollab = -1;
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT l.item_id, l.collaborator_id, c.username, l.label_json, i.text
         FROM labels l
         JOIN collaborators c ON c.id = l.collaborator_id
         LEFT JOIN items i ON i.project_id = l.project_id AND i.item_id = l.item_id
         WHERE l.project_id = ?1 AND (l.item_id > ?2 OR (l.item_id = ?2 AND l.collaborator_id > ?3))
         ORDER BY l.item_id, l.collaborator_id
         LIMIT ?4`,
      )
      .bind(projectId, afterItem, afterCollab, LABEL_PAGE)
      .all<{ item_id: string; collaborator_id: number; username: string; label_json: string; text: string | null }>();
    for (const row of results) {
      let problem: string | null = null;
      if (row.text === null) {
        problem = 'item text is missing';
      } else {
        let label: unknown;
        try {
          label = JSON.parse(row.label_json);
        } catch {
          problem = 'stored label is not valid JSON';
        }
        if (problem === null) {
          const verdict = validateLabel(schema, row.text, label);
          if (!verdict.ok) problem = verdict.error;
        }
      }
      if (problem !== null) {
        invalid.push({ collaborator: row.username, id: row.item_id, error: problem });
        if (invalid.length >= MAX_INVALID) return invalid;
      }
    }
    const last = results[results.length - 1];
    if (!last || results.length < LABEL_PAGE) return invalid;
    afterItem = last.item_id;
    afterCollab = last.collaborator_id;
  }
}

admin.put('/api/admin/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!validSlug(slug)) return error('invalid slug: use lowercase letters, digits and "-" (max 63 chars)', 400);
  const body = await readBody(c.req.raw);
  if (body instanceof Response) return body;

  if (typeof body.schema_yaml !== 'string') return error('"schema_yaml" must be a string', 400);
  if (body.schema === undefined || body.schema === null) return error('"schema" is required', 400);
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return error('"name" must be a non-empty string', 400);
    name = body.name.trim();
  }
  let showProposals: boolean | undefined;
  if (body.show_proposals !== undefined && body.show_proposals !== null) {
    if (typeof body.show_proposals !== 'boolean') return error('"show_proposals" must be a boolean', 400);
    showProposals = body.show_proposals;
  }
  let schema: Schema;
  try {
    schema = parseSchema(body.schema);
  } catch (e) {
    if (e instanceof SchemaError) return error(`invalid schema: ${e.message}`, 400);
    throw e;
  }
  const schemaJson = JSON.stringify(schema);

  const db = c.env.DB;
  const existing = await findProject(db, slug);
  const ts = now();
  let projectId: number;
  let showFlag: boolean;
  let row: Pick<ProjectRow, 'slug' | 'name' | 'created_at' | 'updated_at'>;
  if (!existing) {
    const finalName = name ?? slug;
    const res = await db
      .prepare(
        'INSERT INTO projects (slug, name, schema_json, schema_yaml, show_proposals, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
      )
      .bind(slug, finalName, schemaJson, body.schema_yaml, showProposals ? 1 : 0, ts)
      .run();
    showFlag = showProposals ?? false;
    projectId = res.meta.last_row_id;
    row = { slug, name: finalName, created_at: ts, updated_at: ts };
  } else {
    const invalid = await findInvalidLabels(db, existing.id, schema);
    if (invalid.length > 0) {
      return json(
        {
          error: `schema change would invalidate stored labels (first ${invalid.length} listed); nothing was changed`,
          invalid,
        },
        409,
      );
    }
    const finalName = name ?? existing.name;
    showFlag = showProposals ?? existing.show_proposals !== 0;
    await db
      .prepare(
        'UPDATE projects SET name = ?2, schema_json = ?3, schema_yaml = ?4, show_proposals = ?5, updated_at = ?6 WHERE id = ?1',
      )
      .bind(existing.id, finalName, schemaJson, body.schema_yaml, showFlag ? 1 : 0, ts)
      .run();
    projectId = existing.id;
    row = { slug, name: finalName, created_at: existing.created_at, updated_at: ts };
  }
  return json({
    project: { ...rowToProject(row, await projectCounts(db, projectId)), show_proposals: showFlag },
    created: !existing,
  });
});

admin.get('/api/admin/projects/:slug', async (c) => {
  const db = c.env.DB;
  const row = await findProject(db, c.req.param('slug'));
  if (!row) return error('project not found', 404);
  const project = parseProject(row);
  const counts = await projectCounts(db, row.id);
  const { results } = await db
    .prepare(
      `SELECT c.username, c.disabled,
              COUNT(l.item_id) AS labelled,
              COALESCE(SUM(l.annotation_status = 'complete'), 0) AS complete,
              COALESCE(SUM(l.annotation_status = 'uncertain'), 0) AS uncertain,
              COALESCE(SUM(l.annotation_status = 'skipped'), 0) AS skipped,
              MAX(l.updated_at) AS last_label_at
       FROM assignments a
       JOIN collaborators c ON c.id = a.collaborator_id
       LEFT JOIN labels l ON l.project_id = a.project_id AND l.collaborator_id = a.collaborator_id
       WHERE a.project_id = ?1
       GROUP BY c.id
       ORDER BY c.username`,
    )
    .bind(row.id)
    .all<{
      username: string;
      disabled: number;
      labelled: number;
      complete: number;
      uncertain: number;
      skipped: number;
      last_label_at: number | null;
    }>();
  return json({
    project: {
      slug: row.slug,
      name: row.name,
      schema: project.schema,
      schema_yaml: row.schema_yaml,
      show_proposals: row.show_proposals !== 0,
      items: counts.items,
      proposals: counts.proposals,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    collaborators: results.map((r) => ({ ...r, disabled: r.disabled !== 0 })),
  });
});

admin.delete('/api/admin/projects/:slug', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM projects WHERE slug = ?1').bind(c.req.param('slug')).run();
  if (res.meta.changes === 0) return error('project not found', 404);
  return json({ deleted: true });
});

// ---------------------------------------------------------------------------------------------
// items

admin.post('/api/admin/projects/:slug/items', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const body = await readBody(c.req.raw);
  if (body instanceof Response) return body;

  const raw = body.items;
  if (!Array.isArray(raw)) return error('"items" must be an array', 400);
  if (raw.length > MAX_PER_CALL) return error(`too many items: at most ${MAX_PER_CALL} per call`, 413);

  const incoming = new Map<string, { position: number; text: string }>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return error(`items[${index}]: expected an object`, 400);
    if (typeof entry.id !== 'string' || entry.id === '') return error(`items[${index}]: "id" must be a non-empty string`, 400);
    if (typeof entry.text !== 'string') return error(`items[${index}]: "text" must be a string`, 400);
    if (typeof entry.position !== 'number' || !Number.isInteger(entry.position)) {
      return error(`items[${index}]: "position" must be an integer`, 400);
    }
    if (incoming.has(entry.id)) return error(`items[${index}]: duplicate id "${entry.id}"`, 400);
    incoming.set(entry.id, { position: entry.position, text: entry.text });
  }
  if (incoming.size === 0) return json({ inserted: 0, updated: 0, unchanged: 0 });

  const { results: existingRows } = await db
    .prepare(
      `SELECT item_id, position, text FROM items
       WHERE project_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(project.id, JSON.stringify([...incoming.keys()]))
    .all<{ item_id: string; position: number; text: string }>();
  const existing = new Map(existingRows.map((r) => [r.item_id, r] as const));

  const toInsert: string[] = [];
  const toUpdate: string[] = [];
  const textChanged: string[] = [];
  for (const [id, item] of incoming) {
    const old = existing.get(id);
    if (!old) {
      toInsert.push(id);
    } else if (old.text !== item.text) {
      toUpdate.push(id);
      textChanged.push(id);
    } else if (old.position !== item.position) {
      toUpdate.push(id);
    }
  }

  if (textChanged.length > 0) {
    const { results: labelled } = await db
      .prepare(
        `SELECT DISTINCT item_id FROM labels
         WHERE project_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(project.id, JSON.stringify(textChanged))
      .all<{ item_id: string }>();
    if (labelled.length > 0) {
      const ids = labelled.map((r) => r.item_id);
      return json(
        {
          error: `cannot change the text of ${ids.length} item(s) that already have labels; nothing in this call was written`,
          ids,
        },
        409,
      );
    }
  }

  const statements: D1PreparedStatement[] = [];
  const insert = db.prepare('INSERT INTO items (project_id, item_id, position, text) VALUES (?1, ?2, ?3, ?4)');
  const update = db.prepare('UPDATE items SET position = ?3, text = ?4 WHERE project_id = ?1 AND item_id = ?2');
  for (const id of toInsert) {
    const item = incoming.get(id);
    if (item) statements.push(insert.bind(project.id, id, item.position, item.text));
  }
  for (const id of toUpdate) {
    const item = incoming.get(id);
    if (item) statements.push(update.bind(project.id, id, item.position, item.text));
  }
  await runBatches(db, statements);

  return json({
    inserted: toInsert.length,
    updated: toUpdate.length,
    unchanged: incoming.size - toInsert.length - toUpdate.length,
  });
});

admin.get('/api/admin/projects/:slug/items', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const offset = intParam(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.req.query('limit'), MAX_PER_CALL, 1, MAX_PER_CALL);
  if (offset === null) return error('"offset" must be a non-negative integer', 400);
  if (limit === null) return error('"limit" must be a positive integer', 400);

  const { results } = await db
    .prepare(
      `SELECT item_id AS id, position, text FROM items
       WHERE project_id = ?1 ORDER BY position, item_id LIMIT ?2 OFFSET ?3`,
    )
    .bind(project.id, limit, offset)
    .all<{ id: string; position: number; text: string }>();
  const total = await db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE project_id = ?1')
    .bind(project.id)
    .first<{ n: number }>();
  return json({ items: results, total: total?.n ?? 0 });
});

// ---------------------------------------------------------------------------------------------
// proposals

/** Structural check of a Quet proposal (never against the schema or the item text). */
function proposalProblem(proposal: unknown, spanNames: readonly string[]): string | null {
  if (!isRecord(proposal)) return 'expected an object';
  if (typeof proposal.id !== 'string' || proposal.id === '') return '"id" must be a non-empty string';
  if (typeof proposal.annotation_status !== 'string') return '"annotation_status" must be a string';
  const type = proposal.type;
  if (type !== undefined && type !== null && typeof type !== 'string') return '"type" must be a string or null';
  for (const name of spanNames) {
    const span = proposal[name];
    if (span === undefined || span === null) continue;
    if (
      !isRecord(span) ||
      typeof span.text !== 'string' ||
      typeof span.start !== 'number' ||
      !Number.isInteger(span.start) ||
      typeof span.end !== 'number' ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end < span.start
    ) {
      return `"${name}" must be null or {"text","start","end"} with integer offsets`;
    }
  }
  const spanStatus = proposal.span_status;
  if (spanStatus !== undefined && spanStatus !== null) {
    if (!isRecord(spanStatus) || Object.values(spanStatus).some((v) => typeof v !== 'string')) {
      return '"span_status" must be an object of strings';
    }
  }
  const note = proposal.note;
  if (note !== undefined && note !== null && typeof note !== 'string') return '"note" must be a string';
  const reason = proposal.reason;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return '"reason" must be a string';
  const confidence = proposal.confidence;
  if (confidence !== undefined && confidence !== null) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return '"confidence" must be a number from 0 to 1';
    }
  }
  return null;
}

admin.post('/api/admin/projects/:slug/proposals', async (c) => {
  const db = c.env.DB;
  const row = await findProject(db, c.req.param('slug'));
  if (!row) return error('project not found', 404);
  const body = await readBody(c.req.raw);
  if (body instanceof Response) return body;

  const raw = body.proposals;
  if (!Array.isArray(raw)) return error('"proposals" must be an array', 400);
  if (raw.length > MAX_PER_CALL) return error(`too many proposals: at most ${MAX_PER_CALL} per call`, 413);

  const spanNames = parseProject(row).schema.spans.map((s) => s.name);
  const byId = new Map<string, unknown>();
  for (const [index, proposal] of raw.entries()) {
    const problem = proposalProblem(proposal, spanNames);
    if (problem !== null) return error(`proposals[${index}]: ${problem}`, 400);
    const id = isRecord(proposal) ? proposal.id : undefined;
    if (typeof id !== 'string') return error(`proposals[${index}]: "id" must be a non-empty string`, 400);
    if (byId.has(id)) return error(`proposals[${index}]: duplicate id "${id}"`, 400);
    byId.set(id, proposal);
  }
  if (byId.size === 0) return json({ upserted: 0, ignored: [] });

  const { results: found } = await db
    .prepare(
      `SELECT item_id FROM items
       WHERE project_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(row.id, JSON.stringify([...byId.keys()]))
    .all<{ item_id: string }>();
  const known = new Set(found.map((r) => r.item_id));

  const ignored: string[] = [];
  const statements: D1PreparedStatement[] = [];
  const upsert = db.prepare(
    `INSERT INTO proposals (project_id, item_id, proposal_json) VALUES (?1, ?2, ?3)
     ON CONFLICT (project_id, item_id) DO UPDATE SET proposal_json = excluded.proposal_json`,
  );
  for (const [id, proposal] of byId) {
    if (known.has(id)) statements.push(upsert.bind(row.id, id, JSON.stringify(proposal)));
    else ignored.push(id);
  }
  await runBatches(db, statements);
  return json({ upserted: statements.length, ignored });
});

admin.delete('/api/admin/projects/:slug/proposals', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const res = await db.prepare('DELETE FROM proposals WHERE project_id = ?1').bind(project.id).run();
  return json({ deleted: res.meta.changes });
});

// ---------------------------------------------------------------------------------------------
// labels

type LabelCursor = [updatedAt: number, itemId: string, collaboratorId: number];

function encodeCursor(cursor: LabelCursor): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(cursor))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(text: string): LabelCursor | null {
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'number'
    ) {
      return [parsed[0], parsed[1], parsed[2]];
    }
  } catch {
    // fall through
  }
  return null;
}

admin.get('/api/admin/projects/:slug/labels', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);

  const limit = intParam(c.req.query('limit'), MAX_PER_CALL, 1, MAX_PER_CALL);
  if (limit === null) return error('"limit" must be a positive integer', 400);
  const since = intParam(c.req.query('since'), 0, 0, Number.MAX_SAFE_INTEGER);
  if (since === null) return error('"since" must be a non-negative integer (Unix ms)', 400);

  let collaboratorId: number | null = null;
  const username = c.req.query('collaborator');
  if (username !== undefined && username !== '') {
    const user = await db
      .prepare('SELECT id FROM collaborators WHERE username = ?1')
      .bind(username)
      .first<{ id: number }>();
    if (!user) return error('collaborator not found', 404);
    collaboratorId = user.id;
  }

  let cursor: LabelCursor | null = null;
  const cursorText = c.req.query('cursor');
  if (cursorText !== undefined && cursorText !== '') {
    cursor = decodeCursor(cursorText);
    if (!cursor) return error('invalid cursor', 400);
  }

  const { results } = await db
    .prepare(
      `SELECT l.item_id, l.collaborator_id, c.username, l.label_json, l.updated_at
       FROM labels l JOIN collaborators c ON c.id = l.collaborator_id
       WHERE l.project_id = ?1
         AND (?2 IS NULL OR l.collaborator_id = ?2)
         AND l.updated_at >= ?3
         AND (?4 IS NULL OR l.updated_at > ?4
              OR (l.updated_at = ?4 AND (l.item_id > ?5 OR (l.item_id = ?5 AND l.collaborator_id > ?6))))
       ORDER BY l.updated_at, l.item_id, l.collaborator_id
       LIMIT ?7`,
    )
    .bind(project.id, collaboratorId, since, cursor?.[0] ?? null, cursor?.[1] ?? '', cursor?.[2] ?? 0, limit + 1)
    .all<{ item_id: string; collaborator_id: number; username: string; label_json: string; updated_at: number }>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = results.length > limit && last ? encodeCursor([last.updated_at, last.item_id, last.collaborator_id]) : null;
  return json({
    labels: page.map((r) => ({
      collaborator: r.username,
      updated_at: r.updated_at,
      label: JSON.parse(r.label_json) as unknown,
    })),
    next_cursor: nextCursor,
  });
});

// ---------------------------------------------------------------------------------------------
// collaborators

admin.get('/api/admin/collaborators', async (c) => {
  const db = c.env.DB;
  const { results: users } = await db
    .prepare('SELECT id, username, disabled, created_at FROM collaborators ORDER BY username')
    .all<Pick<CollaboratorRow, 'id' | 'username' | 'disabled' | 'created_at'>>();
  const { results: assigned } = await db
    .prepare(
      `SELECT a.collaborator_id, p.slug FROM assignments a
       JOIN projects p ON p.id = a.project_id ORDER BY p.slug`,
    )
    .all<{ collaborator_id: number; slug: string }>();
  const slugsByUser = new Map<number, string[]>();
  for (const a of assigned) {
    const list = slugsByUser.get(a.collaborator_id);
    if (list) list.push(a.slug);
    else slugsByUser.set(a.collaborator_id, [a.slug]);
  }
  return json({
    collaborators: users.map((u) => ({
      username: u.username,
      disabled: u.disabled !== 0,
      created_at: u.created_at,
      projects: slugsByUser.get(u.id) ?? [],
    })),
  });
});

admin.post('/api/admin/collaborators', async (c) => {
  const db = c.env.DB;
  const body = await readBody(c.req.raw);
  if (body instanceof Response) return body;

  const username = body.username;
  if (typeof username !== 'string' || !validUsername(username)) {
    return error('invalid username: 2-32 chars of lowercase letters, digits, ".", "_" or "-", starting with a letter or digit', 400);
  }
  let password: string;
  if (body.password === undefined || body.password === null) {
    password = generatePassword(16);
  } else if (typeof body.password === 'string' && body.password !== '') {
    password = body.password;
  } else {
    return error('"password" must be a non-empty string', 400);
  }

  const taken = await db.prepare('SELECT 1 AS x FROM collaborators WHERE username = ?1').bind(username).first();
  if (taken) return error('collaborator already exists', 409);

  const hashed = await hashPassword(password);
  try {
    await db
      .prepare(
        `INSERT INTO collaborators (username, password_hash, password_salt, password_iterations, disabled, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
      )
      .bind(username, hashed.hash, hashed.salt, hashed.iterations, now())
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return error('collaborator already exists', 409);
    throw e;
  }
  return json({ username, password });
});

admin.patch('/api/admin/collaborators/:username', async (c) => {
  const db = c.env.DB;
  const username = c.req.param('username');
  const body = await readBody(c.req.raw);
  if (body instanceof Response) return body;

  const { password, disabled } = body;
  if (password === undefined && disabled === undefined) return error('nothing to change: send "password" and/or "disabled"', 400);
  if (password !== undefined && password !== true && (typeof password !== 'string' || password === '')) {
    return error('"password" must be a non-empty string or true', 400);
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') return error('"disabled" must be a boolean', 400);

  const user = await db
    .prepare('SELECT id FROM collaborators WHERE username = ?1')
    .bind(username)
    .first<{ id: number }>();
  if (!user) return error('collaborator not found', 404);

  const statements: D1PreparedStatement[] = [];
  let generated: string | undefined;
  if (password !== undefined) {
    let plain: string;
    if (typeof password === 'string') {
      plain = password;
    } else {
      generated = generatePassword(16);
      plain = generated;
    }
    const hashed = await hashPassword(plain);
    statements.push(
      db
        .prepare('UPDATE collaborators SET password_hash = ?2, password_salt = ?3, password_iterations = ?4 WHERE id = ?1')
        .bind(user.id, hashed.hash, hashed.salt, hashed.iterations),
      db.prepare('DELETE FROM sessions WHERE collaborator_id = ?1').bind(user.id),
    );
  }
  if (disabled !== undefined) {
    statements.push(db.prepare('UPDATE collaborators SET disabled = ?2 WHERE id = ?1').bind(user.id, disabled ? 1 : 0));
  }
  await db.batch(statements);
  return json(generated === undefined ? { username } : { username, password: generated });
});

admin.delete('/api/admin/collaborators/:username', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM collaborators WHERE username = ?1').bind(c.req.param('username')).run();
  if (res.meta.changes === 0) return error('collaborator not found', 404);
  return json({ deleted: true });
});

// ---------------------------------------------------------------------------------------------
// assignments

admin.put('/api/admin/projects/:slug/collaborators/:username', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const user = await db
    .prepare('SELECT id FROM collaborators WHERE username = ?1')
    .bind(c.req.param('username'))
    .first<{ id: number }>();
  if (!user) return error('collaborator not found', 404);
  await db
    .prepare('INSERT OR IGNORE INTO assignments (project_id, collaborator_id, created_at) VALUES (?1, ?2, ?3)')
    .bind(project.id, user.id, now())
    .run();
  return json({ assigned: true });
});

admin.delete('/api/admin/projects/:slug/collaborators/:username', async (c) => {
  const db = c.env.DB;
  const project = await findProject(db, c.req.param('slug'));
  if (!project) return error('project not found', 404);
  const user = await db
    .prepare('SELECT id FROM collaborators WHERE username = ?1')
    .bind(c.req.param('username'))
    .first<{ id: number }>();
  if (!user) return error('collaborator not found', 404);
  await db
    .prepare('DELETE FROM assignments WHERE project_id = ?1 AND collaborator_id = ?2')
    .bind(project.id, user.id)
    .run();
  return json({ assigned: false });
});
