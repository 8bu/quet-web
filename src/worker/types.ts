import type { Schema } from '../shared/schema';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_ADMIN_BYPASS?: string;
}

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  schema_json: string;
  schema_yaml: string;
  created_at: number;
  updated_at: number;
}

export interface ItemRow {
  project_id: number;
  item_id: string;
  position: number;
  text: string;
}

export interface ProposalRow {
  project_id: number;
  item_id: string;
  proposal_json: string;
}

export interface LabelRow {
  project_id: number;
  item_id: string;
  collaborator_id: number;
  label_json: string;
  annotation_status: string;
  updated_at: number;
}

export interface CollaboratorRow {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  disabled: number;
  created_at: number;
}

export interface SessionRow {
  token_hash: string;
  collaborator_id: number;
  expires_at: number;
  created_at: number;
}

/** Hono context variables set by the two auth middlewares. */
export interface AdminVars {
  Variables: { identity: string };
}

export interface CollabVars {
  Variables: { collaboratorId: number; username: string };
}

export type ProjectWithSchema = ProjectRow & { schema: Schema };

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}
