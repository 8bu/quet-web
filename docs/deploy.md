# Deployment record

Everything below was done in the Cloudflare dashboard / `wrangler` for this project. The account is
`71Z` (`d3fc0198c8197514b262b12e3c6639a4`), the zone is the one that holds your custom domain (already on Cloudflare). The domain itself is
not stored in the repo. See [Custom domain](#custom-domain).

## Worker

| Item | Value |
| --- | --- |
| Worker name | `quet-web` |
| Entry | `src/worker/index.ts` (Hono), assets from `public/` with `run_worker_first: true` |
| Custom domain | `QUET_DOMAIN`, passed to `wrangler deploy --domain` (no `routes` in `wrangler.jsonc`) |
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

## Custom domain

`wrangler.jsonc` has no `routes`, so the repo names no domain. `npm run deploy` runs
`wrangler deploy --domain "$QUET_DOMAIN"`. In wrangler 4 this flag adds the route
`{ "pattern": "<domain>", "custom_domain": true }` to the deploy, the same as the old config entry.
Set `QUET_DOMAIN` in one of two ways:

- Shell: `QUET_DOMAIN=quet.example.com npm run deploy`.
- File: copy `.deploy.env.example` to `.deploy.env` (gitignored) and set `QUET_DOMAIN=quet.example.com`.

`npm run deploy` exits with an error if `QUET_DOMAIN` is unset or is not a plain host name. Extra
arguments go to wrangler, so `npm run deploy -- --dry-run` checks the command without a deploy.
`wrangler dev` has no domain, so it keeps the local host.

## Zero Trust Access

Team domain `71zone.cloudflareaccess.com` (team name `71ZONE`) already existed.

| Item | Value |
| --- | --- |
| Application | `quet-web admin`, self-hosted, session 24 h |
| Destinations | `<your-domain>/admin*`, `<your-domain>/api/admin*` |
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
`quet web remote add origin https://<your-domain>` plus `quet web login origin` (two lines on stdin)
stores the pair; `QUET_WEB_URL`, `QUET_ACCESS_CLIENT_ID` and `QUET_ACCESS_CLIENT_SECRET` override it
for one shell.

> **Resolved (2026-10-04).** Two independent faults kept the service token out, both from reading the
> dashboard off screenshots:
>
> 1. `ACCESS_AUD` was mis-transcribed. Access let the token through but the Worker rejected the JWT it
>    received with `403 {"error":"forbidden: valid Cloudflare Access credentials required"}`, because the
>    audience it checked was not the application's. The live value is in the table above; it comes from
>    decoding the `meta` JWT in an Access redirect, which is the only trustworthy source:
>    `curl -sD - -o /dev/null https://<your-domain>/api/admin/whoami | grep -i ^location` then base64-decode
>    the `meta` payload and read `aud`.
> 2. The service-token policy saved with a token whose secret no longer matched. Access answered `302`
>    with `service_token_status: false`, and the token's page showed `Last Seen: Not Seen Yet`. A token's
>    secret is shown once, at creation; `quet-cli` was recreated as `quet-cli-2` (the create dialog's copy
>    button writes the whole `CF-Access-Client-Secret: <value>` header line to the clipboard, so strip the
>    prefix). The old `quet-cli` token was then removed from the policy and deleted, so exactly one token
>    exists for this application.
>
> Check: `curl -H "CF-Access-Client-Id: $QUET_ACCESS_CLIENT_ID" -H
> "CF-Access-Client-Secret: $QUET_ACCESS_CLIENT_SECRET" https://<your-domain>/api/admin/whoami` returns
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

The whole loop was run against the production domain, not just local: `quet web push` published the multi-span
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

## Release

`package.json` holds the only version number. Release Please changes it; do not edit it by hand.

### How a release happens

1. Merge changes to `main` with [conventional commit](https://www.conventionalcommits.org) titles:
   `feat:` bumps the minor version, `fix:` bumps the patch version, and `feat!:` or a
   `BREAKING CHANGE:` footer bumps the major version (while the version is below 1.0, a breaking
   change bumps the minor version). Other types (`docs:`, `chore:`, `test:`) do not release.
2. The `Release` workflow (`.github/workflows/release.yml`) opens or updates a release PR. The PR
   bumps `package.json` and `package-lock.json` and writes `CHANGELOG.md`. The first release is
   `0.1.0`.
3. Merge the release PR. Release Please tags `vX.Y.Z` and creates the GitHub release.
4. In the same run, the `Deploy` workflow (`.github/workflows/deploy.yml`) starts for that tag. It
   runs the CI checks (`ci.yml`: typecheck, vitest, build), then applies D1 migrations
   (`wrangler d1 migrations apply quet-web --remote`), then runs `wrangler deploy`.

Pushes to `main` and pull requests also run `ci.yml` alone. To deploy without a release, open
Actions → Deploy → Run workflow and enter a ref (default `main`). Every deploy job uses the
`production` environment and one concurrency group, so two deploys never overlap.

Release Please uses the default `GITHUB_TOKEN`. GitHub does not start other workflows from events
that token creates, so the release PR does not run CI by itself. Close and reopen the PR to run CI
on it. For the same reason, the deploy is called directly from the `Release` workflow and not from a
`release: published` trigger.

### Repository secret for the domain

Add the secret `QUET_DOMAIN` in Settings → Secrets and variables → Actions (repository or
`production` environment). The value is the host name of the custom domain, for example
`quet.example.com` (no scheme, no path). It is a secret, not a variable, so GitHub masks it in the
public deploy logs.

`deploy.yml` stops with an error before the deploy step if the secret is empty.

### Repository secrets

Add one secret in Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token from the steps below |

The account ID is not secret. `deploy.yml` sets `CLOUDFLARE_ACCOUNT_ID` as a plain value
(`d3fc0198c8197514b262b12e3c6639a4`). You can store the token on the `production` environment
(Settings → Environments → production) to scope it to deploys.

Also enable Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create
and approve pull requests". Release Please needs it to open the release PR.

### Create the Cloudflare API token

1. Open Cloudflare dashboard → My Profile → API Tokens → Create Token.
2. Pick the **Edit Cloudflare Workers** template.
3. Add one more permission: Account → **D1** → **Edit**. Migrations need it.
4. Under Account Resources, include account `71Z`. Under Zone Resources, include the zone of your
   custom domain (the template already sets this for the custom domain route).
5. Create the token, copy it once, and save it as the `CLOUDFLARE_API_TOKEN` secret.
