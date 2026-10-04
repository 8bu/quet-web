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
| Policy 2 | `Quet CLI service token` — action **Service Auth** — selector **Service Token** = `quet-cli` |
| Application audience (AUD) tag | `e21c77967bc9cf8b602604ca2765d523246c3978551ae38616747676193d8b` |

The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (`jose`, issuer
`https://71zone.cloudflareaccess.com`, audience = the AUD above), so a misconfigured policy is not the
only gate. `/`, `/p/:slug` and the assets stay public — collaborators log in with the app's own
username/password.

### Service token

Created in Zero Trust → Access controls → Service credentials → Service Tokens:

| Item | Value |
| --- | --- |
| Name | `quet-cli` |
| Client ID | `e4764b5d51790529d3b1b9ea98761ef2.access` |
| Client secret | stored outside the repo in `~/.config/quet/web.env` (mode 0600), together with `QUET_WEB_URL=https://quet.8bu.dev` |
| Expiry | non-expiring |

The Quet CLI/TUI sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every `/api/admin` call.

> **Open issue (2026-10-04):** `curl -H 'CF-Access-Client-Id: …' -H 'CF-Access-Client-Secret: …'
> https://quet.8bu.dev/api/admin/whoami` returns `302` to the Access login with
> `service_token_status: false`, i.e. Access did not accept the pair. The client secret was
> transcribed from the dashboard dialog, so it may be wrong. **Next step:** open
> Service Tokens → `quet-cli` and re-read the secret with the copy button (clipboard), or rotate it,
> update `~/.config/quet/web.env`, then re-run the check. Everything else in the chain is verified:
> `/`, `/p/:slug` and `/js/*` return 200, `/admin` and `/api/admin/*` return 302 without credentials,
> and the local bypass/dev flow is fully smoke-tested (54 checks).

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
