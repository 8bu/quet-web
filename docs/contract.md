# quet-web contract

Single source of truth for every slice (Worker, D1, admin dashboard, labelling UI, Quet CLI/TUI).
Data formats follow Quet's `docs/annotating.md` exactly (queue, schema, labels, proposals).

## Decisions (from the user)

- Cloudflare **Worker** with **Workers static assets** + **D1**, custom domain `quet.8bu.dev`. No Pages.
- Admin auth = **Cloudflare Zero Trust Access**. One Access application covers
  `quet.8bu.dev/admin` and `quet.8bu.dev/api/admin`. Policies: the admin's email (browser) and a
  **service token** (Quet CLI/TUI). The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT on
  every `/admin*` and `/api/admin*` request (defense in depth). No app-level admin auth.
- Collaborators: username/password created by the admin; they only see assigned projects.
- **Independent labels per collaborator** (each assigned collaborator labels the whole queue; labels
  are stored per `(project, item, collaborator)`); pull is per collaborator.
- Re-push of a project **upserts** (see Push rules).
- Stack: Hono + vanilla TypeScript (esbuild), no UI framework.
- Quet CLI/TUI changes are done by the Quet agent, not in this repo.

## Offsets

Span `start`/`end` are **Unicode code points** (Go runes), `end` exclusive. Browsers index UTF-16:
always convert through `src/shared/schema.ts` helpers. Never use `String.prototype.slice` offsets
on the wire.

## Normalized schema JSON

The CLI parses/validates schema YAML with Quet's Go code and uploads **both** the raw YAML
(`schema_yaml`, stored verbatim for reference) and this normalized JSON (`schema`):

```json
{
  "version": "expense-v1",
  "types": [{"name": "expense", "description": "Money paid out"}],
  "statuses": [{"name": "complete", "description": "Confident"}],
  "null_label_statuses": ["skipped"],
  "implicit_target": false,
  "spans": [
    {"name": "target", "description": "Counterparty", "null_for_types": ["transfer"], "statuses": []},
    {"name": "value", "description": "Amount", "null_for_types": [], "statuses": ["complete", "uncertain"]}
  ]
}
```

- `version`: string or `null`. Descriptions: `""` when the YAML used a plain list.
- `null_label_statuses`: already resolved (the `[skipped]` default applied when the key was absent).
- Schema **without** `spans:` → `implicit_target: true` and exactly one span
  `{"name":"target","description":"","null_for_types":<null_target_types or []>,"statuses":[]}`.
- Order of `types`, `statuses`, `spans` = YAML order (type order drives the `1`–`9` keys).

## Wire label = Quet label

Labels on the wire are exactly Quet label objects (flat; each declared span name is a top-level key):
`id`, `annotation_status`, `type`, each span (`{"text","start","end"}` or `null`) in schema order,
`span_status` (only when non-empty), `note` (only when non-empty). Proposals on the wire are Quet
proposal objects (extra members kept as-is, e.g. `confidence`, `reason`).

## `src/shared/schema.ts` (used by Worker and browser)

```ts
export interface NamedEntry { name: string; description: string }
export interface SpanField { name: string; description: string; null_for_types: string[]; statuses: string[] }
export interface Schema {
  version: string | null; types: NamedEntry[]; statuses: NamedEntry[];
  null_label_statuses: string[]; implicit_target: boolean; spans: SpanField[];
}
export interface Span { text: string; start: number; end: number }
export type Label = {
  id: string; annotation_status: string; type: string | null;
  span_status?: Record<string, string>; note?: string;
} & Record<string, unknown>;            // span keys: Span | null

export class SchemaError extends Error {}
export function parseSchema(json: unknown): Schema;          // structural checks per Quet rules; throws SchemaError
export function cpLength(text: string): number;
export function cpSlice(text: string, start: number, end: number): string;
export function utf16ToCp(text: string, utf16Index: number): number;
export function cpToUtf16(text: string, cpIndex: number): number;
export function isNullFor(span: SpanField, type: string | null): boolean;
/** Canonical save: applies null_label_statuses (type + every span null, no span_status), fills
 *  default span statuses (first listed) for spans declaring statuses that are not null-for-type,
 *  drops span statuses of null-for-type spans, drops empty span_status/note, canonical key order. */
export function normalizeLabel(schema: Schema, label: Label): Label;
/** Strict Quet validation of a label against the record text. Error wording follows Quet docs,
 *  problems joined with "; ". */
export function validateLabel(schema: Schema, text: string, label: unknown):
  { ok: true; label: Label } | { ok: false; error: string };
/** Display-time proposal check (Quet: "⚠ invalid: <reason>"). */
export function validateProposal(schema: Schema, text: string, proposal: unknown):
  { ok: true } | { ok: false; error: string };
/** Word runs (letters, digits, combining marks) as code-point ranges, for word snapping. */
export function wordRanges(text: string): Array<{ start: number; end: number }>;
```

## D1 tables (`migrations/0001_init.sql`)

```sql
projects(id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
         schema_json TEXT NOT NULL, schema_yaml TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)
items(project_id INTEGER, item_id TEXT, position INTEGER, text TEXT NOT NULL, PRIMARY KEY(project_id, item_id))
proposals(project_id INTEGER, item_id TEXT, proposal_json TEXT NOT NULL, PRIMARY KEY(project_id, item_id))
collaborators(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
              password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL,
              disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER)
assignments(project_id INTEGER, collaborator_id INTEGER, created_at INTEGER, PRIMARY KEY(project_id, collaborator_id))
labels(project_id INTEGER, item_id TEXT, collaborator_id INTEGER, label_json TEXT NOT NULL,
       annotation_status TEXT NOT NULL, updated_at INTEGER NOT NULL,
       PRIMARY KEY(project_id, item_id, collaborator_id))
sessions(token_hash TEXT PRIMARY KEY, collaborator_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER)
```

Foreign keys with `ON DELETE CASCADE` (project → items/proposals/assignments/labels; collaborator →
assignments/labels/sessions). Index `items(project_id, position)`, `labels(project_id, collaborator_id, updated_at)`.
Times are Unix milliseconds. Slugs: `^[a-z0-9][a-z0-9-]{0,62}$`. Usernames: `^[a-z0-9][a-z0-9._-]{1,31}$`.

## Auth

- **Admin** (`/admin*`, `/api/admin*`): require a valid Access JWT (`Cf-Access-Jwt-Assertion`
  header, else `CF_Authorization` cookie), verified with `jose` against
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, issuer `https://<ACCESS_TEAM_DOMAIN>`,
  audience `ACCESS_AUD`. Identity = `email` or service token `common_name`. Missing/invalid → 403
  JSON `{"error":"..."}`. Local dev only: `DEV_ADMIN_BYPASS=1` in `.dev.vars` (never in
  `wrangler.jsonc`) opens the admin surface. There is deliberately no host check: with a
  `custom_domain` route, `wrangler dev` rewrites both `request.url` and `Host` to `quet.8bu.dev`.
- **Collaborator**: `POST /api/login` checks PBKDF2-SHA256 (100000 iterations, 16-byte salt,
  WebCrypto) and sets cookie `quet_session` (32 random bytes base64url; D1 stores SHA-256 hex of it),
  `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`. Disabled collaborators cannot log in and
  their sessions are rejected. Mutating `/api/*` requests require `Content-Type: application/json`
  and, when present, an `Origin` equal to the request origin.
- `src/worker/pw.ts` is the single source of these primitives (frozen, used by both route modules):
  `hashPassword(password) → {hash, salt, iterations}`, `verifyPassword(password, row)` taking the
  `collaborators` row (`password_hash`, `password_salt`, `password_iterations`),
  `generatePassword(length = 20)`, `sha256Hex(value)`, `generateSessionToken()`. Never re-implement
  PBKDF2/base64url/SHA-256 elsewhere.
- Errors everywhere: JSON `{"error": "<message>"}` with 400/401/403/404/409/413.

## Admin API (`/api/admin`, Access-protected; used by dashboard and Quet CLI)

| Method & path | Body / query | Result |
| --- | --- | --- |
| `GET /api/admin/whoami` | | `{"identity":"me@x.com"}` |
| `GET /api/admin/projects` | | `{"projects":[{slug,name,items,proposals,collaborators,show_proposals,created_at,updated_at}]}` |
| `PUT /api/admin/projects/:slug` | `{"schema","schema_yaml","name"?,"show_proposals"?}` | create or update; `{"project":{...},"created":bool}`. `name` defaults to the slug on create and, when omitted on update, the stored name is kept. `show_proposals` defaults to `false` on create and is kept when omitted on update |
| `GET /api/admin/projects/:slug` | | `{"project":{slug,name,schema,schema_yaml,show_proposals,items,proposals,created_at,updated_at},"collaborators":[{username,disabled,labelled,complete,uncertain,skipped,last_label_at}]}` |
| `DELETE /api/admin/projects/:slug` | | `{"deleted":true}` (cascades) |
| `POST /api/admin/projects/:slug/items` | `{"items":[{"id","text","position"}]}` ≤ 1000 per call | upsert; `{"inserted":n,"updated":n,"unchanged":n}` |
| `GET /api/admin/projects/:slug/items` | `?offset=0&limit<=1000` | `{"items":[{"id","position","text"}],"total":n}` in position order (used by `quet web pull` to validate pulled labels against the queue text) |
| `POST /api/admin/projects/:slug/proposals` | `{"proposals":[<quet proposal>]}` ≤ 1000 per call | upsert by id; `{"upserted":n,"ignored":["id",...]}` (ids not in items) |
| `DELETE /api/admin/projects/:slug/proposals` | | remove all proposals |
| `GET /api/admin/projects/:slug/labels` | `?collaborator=<u>` (optional), `&since=<ms>`, `&cursor=<opaque>`, `&limit<=1000` | `{"labels":[{"collaborator","updated_at","label":<quet label>}],"next_cursor":string\|null}` ordered by `updated_at, item_id` |
| `GET /api/admin/collaborators` | | `{"collaborators":[{username,disabled,created_at,projects:[slug]}]}` |
| `POST /api/admin/collaborators` | `{"username","password"?}` | `{"username","password"}` (password generated, 16 chars, if absent; shown once) |
| `PATCH /api/admin/collaborators/:username` | `{"password"?: string\|true, "disabled"?: bool}` | `password:true` regenerates; returns `{"username","password"?}`; password change revokes sessions |
| `DELETE /api/admin/collaborators/:username` | | `{"deleted":true}` (cascades labels!) |
| `PUT /api/admin/projects/:slug/collaborators/:username` | | assign; `{"assigned":true}` |
| `DELETE /api/admin/projects/:slug/collaborators/:username` | | unassign (labels kept); `{"assigned":false}` |

### Push rules (re-push upserts)

- `PUT project`: `schema` must pass `parseSchema`. On update, every stored label is re-validated
  against the new schema and its item text; if any fails → 409
  `{"error":"...","invalid":[{"collaborator","id","error"}]}` (first 50) and nothing changes.
- `POST items`: ids missing from a push are kept (never deleted). New ids are inserted; existing ids
  get `position` updated; a changed `text` on an item that has any label → 409 listing those ids,
  nothing in that call written. Items without labels may change text.
- `POST proposals`: upsert by `id`; validated only structurally (Quet proposal shape), never against
  the schema (display-time check, like Quet).
- The CLI pushes: `PUT project` → items in chunks → (optional) `DELETE proposals` then proposals in chunks.

## Collaborator API (`/api`, session cookie)

| Method & path | Body / query | Result |
| --- | --- | --- |
| `POST /api/login` | `{"username","password"}` | sets cookie; `{"username"}`; 401 `{"error":"invalid username or password"}` |
| `POST /api/logout` | | clears cookie + session |
| `GET /api/me` | | `{"username"}` or 401 |
| `GET /api/projects` | | `{"projects":[{slug,name,items,labelled,complete,uncertain,skipped}]}` (assigned only) |
| `GET /api/projects/:slug` | | `{"project":{slug,name,schema,show_proposals,items}}` (404 if not assigned) |
| `GET /api/projects/:slug/items` | `?offset=0&limit<=1000` | `{"items":[{"id","position","text","proposal":<obj>\|null,"label":<my label>\|null}],"total":n}` in position order |
| `PUT /api/projects/:slug/labels/:item_id` | `{"label":<quet label>}` | server `normalizeLabel` + `validateLabel`; 400 with Quet error text if invalid; `{"label":<saved>}` |
| `DELETE /api/projects/:slug/labels/:item_id` | | removes my label (undo of a first mark) |

## Pages and assets

- `public/` = Workers static assets (binding `ASSETS`, `run_worker_first: true`); the Worker routes:
  `/` → `public/index.html` (login + project list), `/p/:slug` → `public/label.html`,
  `/admin` and `/admin/*` → `public/admin.html` (after Access check), other paths → `ASSETS`.
- Browser code: `src/web/<entry>.ts` → `public/js/<entry>.js` by `node scripts/build-web.mjs`
  (esbuild, bundles `src/shared`). Entries: `admin.ts`, `index.ts`, `label.ts`.
- Responses carry `Content-Security-Policy: default-src 'self'; style-src 'self'; img-src 'self' data:`.

## Labelling screen (decided with the user, 2026-10-04)

The collaborator screen at `/p/:slug` is **prototype A (focus card) plus a collapsible queue drawer**
(prototype files in `prototypes/`, all three verified in a browser). Confirmed behaviour:

- Keys `1`–`9` set the type in schema order; `enter`/`u`/`s` save complete/uncertain/skipped; `x` and
  `n` mark or null the active span; `tab`/`shift+tab` switch span fields; `c` cycles the active
  field's span status; `j`/`k` and arrows walk the queue; `[`/`]` move to unlabelled records; `z`
  undoes (through the API); `m` toggles word/character mouse snapping; `\` toggles the drawer; `?`
  toggles help; `esc` discards the draft.
- **Web-only rule:** `enter` (complete) is refused while a span that applies to the type is unmarked;
  the person must mark it or press `n`. `u` and `s` are never gated. This is deliberate and is stated
  in the help overlay.
- After a save the screen advances to the next record **without a label** (wrapping once); `z`
  returns and restores what the save replaced.
- Proposals are shown only when the project's `show_proposals` is true (**default false**), so
  independent annotators are not biased by machine suggestions. When shown they sit in a dashed
  `Proposal — not accepted` block; `p` accepts (a normal, undoable save) and `P` loads the values into
  the draft. An invalid proposal refuses `p` with the reason.
- Light theme, 36px serif record text, one highlighted span per field.
- The hint line guides, it does not report: it names the **first unmarked** field ("mark the value…"),
  while the active field is the highlighted field row (`tab`/`shift+tab` move it and a toast names it).
  A mouse drag always writes to the **active** field, so dragging the value's text while `Target` is
  active overwrites the target's span. That is intended, and it is the one place where the hint and the
  highlighted row can point at different fields; marking a span auto-advances to the next unmarked field.

## Quet CLI/TUI (implemented by the Quet agent)

Env: `QUET_WEB_URL` (default `https://quet.8bu.dev`), `QUET_ACCESS_CLIENT_ID`,
`QUET_ACCESS_CLIENT_SECRET` → sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every
`/api/admin` call.

- `quet web push <queue.jsonl> --schema <schema.yaml> [--proposals <p.jsonl>] --project <slug> [--name <name>]`
- `quet web list` (projects + per-collaborator progress)
- `quet web pull --project <slug> --user <username> (--out <labels.jsonl> | --labels <labels.jsonl>)`:
  `--out` writes a fresh Quet labels file in queue order; `--labels` merges like re-check (replace /
  append pulled ids, keep others byte for byte, atomic write, refuse if changed underneath).
- TUI: in `quet annotate`, a pull action that fetches a collaborator's labels, shows an instant diff
  preview against the open labels, and merges on confirm; plus a publish action calling push.
