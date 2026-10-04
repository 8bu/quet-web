-- quet-web initial schema (Cloudflare D1 / SQLite).
-- All timestamps are Unix milliseconds stored as INTEGER.
-- Foreign keys cascade: deleting a project removes its items, proposals,
-- assignments and labels; deleting a collaborator removes their assignments,
-- labels and sessions.

-- projects: one row per labelling project (a pushed Quet queue + schema).
-- schema_json is the normalized schema JSON (see docs/contract.md);
-- schema_yaml is the raw YAML as uploaded, kept verbatim for reference.
CREATE TABLE projects (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  schema_yaml TEXT NOT NULL,
  created_at  INTEGER,
  updated_at  INTEGER
);

-- items: the queue records of a project. position is the queue order.
CREATE TABLE items (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id    TEXT    NOT NULL,
  position   INTEGER,
  text       TEXT    NOT NULL,
  PRIMARY KEY (project_id, item_id)
);

CREATE INDEX items_project_position ON items (project_id, position);

-- proposals: optional Quet proposal object per item, stored as received.
CREATE TABLE proposals (
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id       TEXT    NOT NULL,
  proposal_json TEXT    NOT NULL,
  PRIMARY KEY (project_id, item_id)
);

-- collaborators: username/password accounts created by the admin.
-- Passwords are PBKDF2-SHA256 (hash + per-user salt + iteration count).
CREATE TABLE collaborators (
  id                  INTEGER PRIMARY KEY,
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  password_salt       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL,
  disabled            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER
);

-- assignments: which collaborators may see and label which projects.
CREATE TABLE assignments (
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collaborator_id INTEGER NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  created_at      INTEGER,
  PRIMARY KEY (project_id, collaborator_id)
);

-- Supports the cascade on collaborator delete and "projects of a collaborator".
CREATE INDEX assignments_collaborator ON assignments (collaborator_id);

-- labels: independent labels per (project, item, collaborator).
-- label_json is the flat Quet label object; annotation_status is denormalized
-- from it for progress counts.
CREATE TABLE labels (
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id           TEXT    NOT NULL,
  collaborator_id   INTEGER NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  label_json        TEXT    NOT NULL,
  annotation_status TEXT    NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (project_id, item_id, collaborator_id)
);

-- Pull (ordered by updated_at) and per-collaborator progress queries.
CREATE INDEX labels_project_collaborator_updated ON labels (project_id, collaborator_id, updated_at);

-- Supports the cascade on collaborator delete.
CREATE INDEX labels_collaborator ON labels (collaborator_id);

-- sessions: collaborator login sessions. token_hash is the SHA-256 hex of the
-- random cookie token; the raw token is never stored.
CREATE TABLE sessions (
  token_hash      TEXT    PRIMARY KEY,
  collaborator_id INTEGER NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER
);

-- Expired-session cleanup, and revoking all sessions of a collaborator.
CREATE INDEX sessions_expires_at ON sessions (expires_at);
CREATE INDEX sessions_collaborator ON sessions (collaborator_id);
