import { parseSchema } from '../shared/schema';
import type { ProjectRow, ProjectWithSchema } from './types';

/** Current time in Unix milliseconds. */
export function now(): number {
  return Date.now();
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function validUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/** Split `items` into consecutive arrays of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a stored project row: `schema_json` is parsed and re-checked with `parseSchema`. */
export function parseProject(row: ProjectRow): ProjectWithSchema {
  const schema = parseSchema(JSON.parse(row.schema_json));
  return { ...row, schema };
}

export interface ProjectCounts {
  items: number;
  proposals: number;
  collaborators: number;
}

/** Summary shape used by the project list and the PUT response. */
export function rowToProject(
  row: Pick<ProjectRow, 'slug' | 'name' | 'created_at' | 'updated_at'>,
  counts: ProjectCounts,
) {
  return {
    slug: row.slug,
    name: row.name,
    items: counts.items,
    proposals: counts.proposals,
    collaborators: counts.collaborators,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
