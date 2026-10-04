# Deployment record

Everything below was done in the Cloudflare dashboard / `wrangler` for this project. The account is
`71Z` (`d3fc0198c8197514b262b12e3c6639a4`), the zone is `8bu.dev` (already on Cloudflare).

## Worker

| Item | Value |
| --- | --- |
| Worker name | `quet-web` |
| Entry | `src/worker/index.ts` (Hono), assets from `public/` with `run_worker_first: true` |
| Custom domain | `quet.8bu.dev` (route `{ "pattern": "quet.8bu.dev", "custom_domain": true }`) |
| Deployed version | recorded by `wrangler deploy`; rerun `npm run deploy` to publish |
| Production vars | `ACCESS_TEAM_DOMAIN=71zone.cloudflareaccess.com`, `ACCESS_AUD=<AUD below>` |
| `DEV_ADMIN_BYPASS` | **never** in `wrangler.jsonc`; only in the gitignored `.dev.vars` for local work |

## D1

| Item | Value |
| --- | --- |
| Database | `quet-web` (region APAC) |
| `database_id` | `88335097-1d2a-45ea-ac96-3b867fa7bb4d` |
| Binding | `DB` |
| Migrations applied (local and remote) | `0001_init.sql` (projects, items, proposals, collaborators, assignments, labels, sessions), `0002_project_show_proposals.sql` (`projects.show_proposals INTEGER NOT NULL DEFAULT 0`) |

Commands used: `npx wrangler d1 migrations apply quet-web --local` and `--remote`,
`npx wrangler d1 create quet-web`, `npm run deploy`.

## Zero Trust Access

Team domain `71zone.cloudflareaccess.com` (team name `71ZONE`) already existed.

| Item | Value |
| --- | --- |
| Application | `quet-web admin`, self-hosted, session 24 h |
| Destinations | `quet.8bu.dev/admin*`, `quet.8bu.dev/api/admin*` |
| Policy 1 | `Admin email` — action **Allow** — selector **Emails** = `hvanlong@pm.me` |
| Policy 2 | `Quet CLI service token` — action **Service Auth** — selector **Service Token** = `quet-cli-2` |
| Application audience (AUD) tag | `e21c779676bc9cfb8b602604ca27665d23246c3978551ae3861674767e7193b8` (read from the live Access meta JWT, not from a screenshot) |

The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (`jose`, issuer
`https://71zone.cloudflareaccess.com`, audience = the AUD above), so a misconfigured policy is not the
only gate. `/`, `/p/:slug` and the assets stay public — collaborators log in with the app's own
username/password.

### Service token

Created in Zero Trust → Access controls → Service credentials → Service Tokens:

| Item | Value |
| --- | --- |
| Name | `quet-cli-2` |
| Client ID | `58b3828effe3b0e4192adb700c84f426.access` |
| Client secret | outside the repo: `~/.config/quet/web.env` (mode 0600) and, for the CLI, `~/.config/quet/remotes.yaml` (mode 0600) |
| Expiry | non-expiring |

The Quet CLI/TUI sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every `/api/admin` call.
`quet web remote add origin https://quet.8bu.dev` plus `quet web login origin` (two lines on stdin)
stores the pair; `QUET_WEB_URL`, `QUET_ACCESS_CLIENT_ID` and `QUET_ACCESS_CLIENT_SECRET` override it
for one shell.

> **Resolved (2026-10-04).** Two independent faults kept the service token out, both from reading the
> dashboard off screenshots:
>
> 1. `ACCESS_AUD` was mis-transcribed. Access let the token through but the Worker rejected the JWT it
>    received with `403 {"error":"forbidden: valid Cloudflare Access credentials required"}`, because the
>    audience it checked was not the application's. The live value is in the table above; it comes from
>    decoding the `meta` JWT in an Access redirect, which is the only trustworthy source:
>    `curl -sD - -o /dev/null https://quet.8bu.dev/api/admin/whoami | grep -i ^location` then base64-decode
>    the `meta` payload and read `aud`.
> 2. The service-token policy saved with a token whose secret no longer matched. Access answered `302`
>    with `service_token_status: false`, and the token's page showed `Last Seen: Not Seen Yet`. A token's
>    secret is shown once, at creation; `quet-cli` was recreated as `quet-cli-2` (the create dialog's copy
>    button writes the whole `CF-Access-Client-Secret: <value>` header line to the clipboard, so strip the
>    prefix). The old `quet-cli` token was then removed from the policy and deleted, so exactly one token
>    exists for this application.
>
> Check: `curl -H "CF-Access-Client-Id: $QUET_ACCESS_CLIENT_ID" -H
> "CF-Access-Client-Secret: $QUET_ACCESS_CLIENT_SECRET" https://quet.8bu.dev/api/admin/whoami` returns
> `200 {"identity":"58b3828effe3b0e4192adb700c84f426.access"}`; with no credentials the same URL returns
> `302` to the Access login.

## Verified behaviours

- Local (`wrangler dev`, `DEV_ADMIN_BYPASS=1`): `bash /tmp/quet-smoke.sh` — 54 checks, 0 failures.
  Covers project create/update, item push and pagination, proposals (incl. ignored ids), collaborator
  create (generated and chosen passwords, duplicate/invalid names), assignment, unauthenticated and
  bad-password 401s, login/session/logout, per-collaborator isolation, label validation errors
  (unknown type, wrong span text, whitespace, null-target type, id mismatch), code-point offsets for
  Vietnamese and astral characters, skip clearing, admin label pull (all collaborators, filtered,
  paginated), 409 on labelling text changes, 409 on schema changes that invalidate labels, password
  regeneration revoking sessions, disabling a collaborator, and the `show_proposals` round-trip.
- Browser (real Chromium): collaborator login and project list; the labelling screen's full keyboard
  map, complete-guard, `n`/`enter` save, undo, queue drawer, help overlay, mouse click/drag/word-snap,
  `Tab` field switching with active-field auto-advance, per-span statuses via `c`, the
  `null_for_types` lock, proposals hidden/shown by the flag, `p` accept and `z` undo of an accept, and
  the admin dashboard (projects table, credential creation, collaborator status, project detail with
  progress and the `Show model proposals to collaborators` checkbox round-tripping to D1).
- Production: `/`, `/p/x`, `/js/label.js` → 200; `/admin`, `/api/admin/whoami` → 302 to Access.

## Production end-to-end (2026-10-04)

The whole loop was run against `quet.8bu.dev`, not just local: `quet web push` published the multi-span
example as project `hello` (5 items, 2 span fields), the admin API created collaborator `reader` with a
generated password and assigned it, a real browser signed in at `/`, opened `/p/hello` and labelled two
records (type key `1`, drag-selected spans, `Enter` to save), and `quet web pull --project hello --user
reader` returned exactly:

```jsonl
{"id":"ms-001","annotation_status":"complete","type":"expense","target":{"text":"Vinamilk","start":10,"end":18},"value":{"text":"500k","start":23,"end":27},"span_status":{"value":"complete"}}
{"id":"ms-002","annotation_status":"complete","type":"expense","target":{"text":"mẹ","start":21,"end":23},"value":{"text":"2tr","start":13,"end":16},"span_status":{"value":"complete"}}
```

Both spans of both records slice the queue text correctly (`text[start:end] == text`), so code-point
offsets hold through the browser, D1 and the CLI. The admin view reported `reader: 2 labelled
(2 complete)`.

**Test data.** The owner deleted project `hello` and collaborator `reader` after the test.
