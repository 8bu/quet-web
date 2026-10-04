# quet-web brief

Build **quet-web**, a web companion to Quet (https://github.com/8bu/quet, local checkout
`/Users/8bu/Projects/quet`, a Go TUI for reviewing and annotating text corpora). Its job is to let
outside collaborators do `quet annotate`-style labelling in a browser, because labelling in the TUI is
exhausting.

Read the Quet annotate docs first so you use the same formats: `/Users/8bu/Projects/quet/docs/annotating.md`
covers the queue JSONL, schema YAML (incl. multi-span `spans:`), labels JSONL and proposals JSONL. The
example files are in `/Users/8bu/Projects/quet/examples/annotation/`.

## Requirements (from the user)

1. Hosted on a Cloudflare **Worker** (no Pages project; Pages is deprecated) with **D1** for storage.
2. Allow outside collaborators.
3. Domain: a custom domain on a Cloudflare zone, set at deploy time (`QUET_DOMAIN`).
4. The admin (via a Cloudflare admin session, no app-level auth for the admin) creates annotation
   projects **from the Quet TUI**: dataset (queue), schema, proposals. So the Quet TUI/CLI in
   `/Users/8bu/Projects/quet` must be updated too. quet-web has an **admin dashboard** where the admin
   shares a project with an outside collaborator by creating a simple username/password credential.
   The collaborator logs in with that username/password and only sees their assigned projects, where
   they do the labelling.
5. **Most important:** the labelling UI must be very simple for the web, for both mouse and keyboard
   use. Do UI design prototype iterations and get human feedback on them before delivering the final UI.
6. Do not assume. If anything is foggy, ask the user.

## Coordination

- The Quet repo is being worked on by another omp agent in herdr pane `wD:pQ`. Before editing
  `/Users/8bu/Projects/quet`, tell that agent what you will change
  (`herdr agent prompt wD:pQ '<message>'`, no `--wait`), so you don't edit the same files at once.
- Don't tag or publish a Quet release without the user's approval.
