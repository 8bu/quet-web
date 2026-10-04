# Quet web

Web companion to [Quet](https://github.com/8bu/quet) so outside collaborators can do
`quet annotate`-style labelling in a browser. Cloudflare Worker + D1 on `quet.8bu.dev`.

- `docs/contract.md` — the interface every slice codes against (API, D1 schema, formats).
- `docs/deploy.md` — infrastructure and dashboard actions taken.
- `src/shared/schema.ts` — Quet schema/label logic shared by Worker and browser.
- `src/worker/` — Hono Worker (admin API behind Cloudflare Access, collaborator API behind sessions).
- `public/`, `src/web/` — vanilla TypeScript front ends.
- `prototypes/` — labelling UI design iterations.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run dev
```

Quet CLI/TUI integration (`quet web push|pull|list`) is implemented in the Quet repo; see
`docs/contract.md` for the API it targets.
