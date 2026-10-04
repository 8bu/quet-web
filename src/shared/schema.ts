// Schema + label logic shared by the Worker and browser bundles.
// Mirrors Quet's `internal/annotate` (docs/annotating.md). Dependency-free; no Node/DOM APIs.

export interface NamedEntry {
  name: string;
  description: string;
}

export interface SpanField {
  name: string;
  description: string;
  null_for_types: string[];
  statuses: string[];
}

export interface Schema {
  version: string | null;
  types: NamedEntry[];
  statuses: NamedEntry[];
  null_label_statuses: string[];
  implicit_target: boolean;
  spans: SpanField[];
}

export interface Span {
  text: string;
  start: number;
  end: number;
}

export type Label = {
  id: string;
  annotation_status: string;
  type: string | null;
  span_status?: Record<string, string>;
  note?: string;
} & Record<string, unknown>; // span keys: Span | null

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const SPAN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Quet's reserved label keys, plus `__proto__` which cannot be a plain own property in JS.
const RESERVED_SPAN_NAMES = ['id', 'annotation_status', 'type', 'note', 'span_status', '__proto__'];
const COMPLETE = 'complete';
const SPAN_KEYS = ['text', 'start', 'end'] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Go-style %q. */
function q(s: string): string {
  return JSON.stringify(s);
}

function list(names: readonly string[]): string {
  return `[${names.join(', ')}]`;
}

function unknownFields(keys: string[]): string {
  return `unknown field(s) [${[...keys].sort().map(q).join(' ')}]`;
}

// ---------------------------------------------------------------------------
// Code-point helpers (Quet offsets are Unicode code points, `end` exclusive)
// ---------------------------------------------------------------------------

/** UTF-16 units taken by the code point starting at `i` (2 only for a valid surrogate pair). */
function unitsAt(text: string, i: number): number {
  const hi = text.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
    const lo = text.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

export function cpLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += unitsAt(text, i)) n++;
  return n;
}

/** UTF-16 index of code-point index `cpIndex`; clamped to `[0, text.length]`. */
export function cpToUtf16(text: string, cpIndex: number): number {
  let i = 0;
  for (let n = 0; n < cpIndex && i < text.length; n++) i += unitsAt(text, i);
  return i;
}

/** Code-point index of UTF-16 index `utf16Index` (clamped); an index inside a surrogate pair maps to that code point. */
export function utf16ToCp(text: string, utf16Index: number): number {
  const limit = Math.min(utf16Index, text.length);
  let i = 0;
  let n = 0;
  while (i < limit) {
    const step = unitsAt(text, i);
    if (i + step > limit) break;
    i += step;
    n++;
  }
  return n;
}

/** Code points `[start, end)` of `text`. */
export function cpSlice(text: string, start: number, end: number): string {
  if (end <= start) return '';
  const a = cpToUtf16(text, start);
  let b = a;
  for (let n = Math.max(start, 0); n < end && b < text.length; n++) b += unitsAt(text, b);
  return text.slice(a, b);
}

// unicode.IsSpace in Go: \t \n \v \f \r space, U+0085, U+00A0, and category Z.
const SPACE_RE = /^[\t\n\v\f\r \u0085\u00a0\p{Z}]$/u;

function isPadded(text: string): boolean {
  // `text` is non-empty: test its first and last code point.
  const first = String.fromCodePoint(text.codePointAt(0) ?? 0);
  let lastStart = text.length - 1;
  if (lastStart > 0) {
    const lo = text.charCodeAt(lastStart);
    const hi = text.charCodeAt(lastStart - 1);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) lastStart--;
  }
  const last = String.fromCodePoint(text.codePointAt(lastStart) ?? 0);
  return SPACE_RE.test(first) || SPACE_RE.test(last);
}

const WORD_CHAR_RE = /^[\p{L}\p{N}\p{M}]$/u;

/** Runs of letters, digits and combining marks as code-point ranges (`end` exclusive). */
export function wordRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  let idx = 0;
  for (const ch of text) {
    if (WORD_CHAR_RE.test(ch)) {
      if (runStart < 0) runStart = idx;
    } else if (runStart >= 0) {
      out.push({ start: runStart, end: idx });
      runStart = -1;
    }
    idx++;
  }
  if (runStart >= 0) out.push({ start: runStart, end: idx });
  return out;
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

function parseEntries(raw: unknown, field: string): NamedEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SchemaError(`${field}: expected a non-empty array`);
  }
  const seen = new Set<string>();
  const out: NamedEntry[] = [];
  raw.forEach((e: unknown, i) => {
    if (!isRecord(e)) throw new SchemaError(`${field}[${i}]: expected an object`);
    const { name, description } = e;
    if (typeof name !== 'string' || name === '') {
      throw new SchemaError(`${field}[${i}].name: expected a non-empty string`);
    }
    if (typeof description !== 'string') {
      throw new SchemaError(`${field}[${i}] (${q(name)}).description: expected a string`);
    }
    if (seen.has(name)) throw new SchemaError(`${field}: duplicate name ${q(name)}`);
    seen.add(name);
    out.push({ name, description });
  });
  return out;
}

function parseNameList(raw: unknown, where: string, declared: Set<string>, kind: string, unique: boolean): string[] {
  if (!Array.isArray(raw)) throw new SchemaError(`${where}: expected an array of ${kind} names`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw as unknown[]) {
    if (typeof v !== 'string') throw new SchemaError(`${where}: expected an array of ${kind} names`);
    if (!declared.has(v)) throw new SchemaError(`${where}: ${q(v)} is not a declared ${kind}`);
    if (unique && seen.has(v)) throw new SchemaError(`${where}: duplicate ${kind} ${q(v)}`);
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Validates the normalized schema JSON uploaded by the Quet CLI and returns a clean copy. */
export function parseSchema(json: unknown): Schema {
  if (!isRecord(json)) throw new SchemaError('schema: expected an object');

  const version = json.version ?? null;
  if (version !== null && typeof version !== 'string') {
    throw new SchemaError('version: expected a string or null');
  }

  const types = parseEntries(json.types, 'types');
  const statuses = parseEntries(json.statuses, 'statuses');
  const typeNames = new Set(types.map((t) => t.name));
  const statusNames = new Set(statuses.map((s) => s.name));

  if (json.null_label_statuses === undefined) {
    throw new SchemaError('null_label_statuses: required (the default must already be applied)');
  }
  const nullLabelStatuses = parseNameList(json.null_label_statuses, 'null_label_statuses', statusNames, 'status', false);

  const implicitTarget = json.implicit_target;
  if (typeof implicitTarget !== 'boolean') {
    throw new SchemaError('implicit_target: expected a boolean');
  }

  const rawSpans = json.spans;
  if (!Array.isArray(rawSpans) || rawSpans.length === 0) {
    throw new SchemaError('spans: expected a non-empty array');
  }
  const spanNames = new Set<string>();
  const spans: SpanField[] = [];
  rawSpans.forEach((e: unknown, i) => {
    if (!isRecord(e)) throw new SchemaError(`spans[${i}]: expected an object`);
    const { name, description } = e;
    if (typeof name !== 'string' || !SPAN_NAME_RE.test(name)) {
      throw new SchemaError(`spans[${i}].name: ${typeof name === 'string' ? q(name) : 'value'} must match ${SPAN_NAME_RE.source}`);
    }
    if (RESERVED_SPAN_NAMES.includes(name)) {
      throw new SchemaError(`spans[${i}].name: ${q(name)} is reserved`);
    }
    if (spanNames.has(name)) throw new SchemaError(`spans: duplicate span ${q(name)}`);
    spanNames.add(name);
    if (typeof description !== 'string') {
      throw new SchemaError(`spans.${name}.description: expected a string`);
    }
    spans.push({
      name,
      description,
      null_for_types: parseNameList(e.null_for_types, `spans.${name}.null_for_types`, typeNames, 'type', true),
      statuses: parseNameList(e.statuses, `spans.${name}.statuses`, statusNames, 'status', true),
    });
  });

  if (implicitTarget) {
    const only = spans[0];
    if (spans.length !== 1 || only === undefined || only.name !== 'target') {
      throw new SchemaError('implicit_target: requires exactly one span named "target"');
    }
    if (only.statuses.length > 0) {
      throw new SchemaError('implicit_target: the implicit "target" span cannot declare statuses');
    }
  }

  return {
    version,
    types,
    statuses,
    null_label_statuses: nullLabelStatuses,
    implicit_target: implicitTarget,
    spans,
  };
}

export function isNullFor(span: SpanField, type: string | null): boolean {
  return type !== null && span.null_for_types.includes(type);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Canonical save: applies null_label_statuses (type + every span null, no span_status), fills
 *  default span statuses (first listed) for spans declaring statuses that are not null-for-type,
 *  drops span statuses of null-for-type spans, drops empty span_status/note, canonical key order. */
export function normalizeLabel(schema: Schema, label: Label): Label {
  const out: Label = { id: label.id, annotation_status: label.annotation_status, type: null };
  const cleared = schema.null_label_statuses.includes(label.annotation_status);
  const type = cleared ? null : typeof label.type === 'string' ? label.type : null;
  out.type = type;

  for (const sp of schema.spans) {
    out[sp.name] = cleared ? null : (label[sp.name] ?? null);
  }

  if (!cleared) {
    const submitted = isRecord(label.span_status) ? label.span_status : {};
    const spanStatus: Record<string, string> = {};
    for (const sp of schema.spans) {
      const first = sp.statuses[0];
      if (first === undefined || isNullFor(sp, type)) continue;
      const given = hasOwn(submitted, sp.name) ? submitted[sp.name] : undefined;
      spanStatus[sp.name] = typeof given === 'string' && sp.statuses.includes(given) ? given : first;
    }
    if (Object.keys(spanStatus).length > 0) out.span_status = spanStatus;
  }

  if (typeof label.note === 'string' && label.note !== '') out.note = label.note;
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Mode = 'label' | 'proposal';

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Structural problems (types and keys); semantic checks only run when there are none. */
function shapeProblems(schema: Schema, obj: Record<string, unknown>, mode: Mode): string[] {
  const problems: string[] = [];
  const hasSpanStatuses = schema.spans.some((sp) => sp.statuses.length > 0);

  if (mode === 'label') {
    const allowed = new Set(['id', 'annotation_status', 'type', 'note', ...schema.spans.map((sp) => sp.name)]);
    if (hasSpanStatuses) allowed.add('span_status');
    const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
    if (unknown.length > 0) problems.push(unknownFields(unknown));
    for (const k of ['id', 'annotation_status', 'type', ...schema.spans.map((sp) => sp.name)]) {
      if (!hasOwn(obj, k)) problems.push(`missing field ${q(k)}`);
    }
  } else if (!hasOwn(obj, 'annotation_status')) {
    problems.push('missing field "annotation_status"');
  }

  if (hasOwn(obj, 'id') && (typeof obj.id !== 'string' || obj.id === '')) {
    problems.push('id: expected a non-empty string');
  }
  if (hasOwn(obj, 'annotation_status') && typeof obj.annotation_status !== 'string') {
    problems.push('annotation_status: expected a string');
  }
  if (hasOwn(obj, 'type') && obj.type !== null && typeof obj.type !== 'string') {
    problems.push('type: expected a string or null');
  }
  if (hasOwn(obj, 'note') && typeof obj.note !== 'string') {
    problems.push('note: expected a string');
  }
  if (mode === 'proposal') {
    const conf = obj.confidence;
    if (conf !== undefined && (typeof conf !== 'number' || !(conf >= 0 && conf <= 1))) {
      problems.push('confidence: expected a number from 0 to 1');
    }
    if (obj.reason !== undefined && typeof obj.reason !== 'string') {
      problems.push('reason: expected a string');
    }
  }

  for (const sp of schema.spans) {
    if (!hasOwn(obj, sp.name)) continue;
    const v = obj[sp.name];
    if (v === null) continue;
    if (!isRecord(v)) {
      problems.push(`${sp.name}: expected an object or null`);
      continue;
    }
    const extra = Object.keys(v).filter((k) => !(SPAN_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) {
      problems.push(`${sp.name}: ${unknownFields(extra)}`);
      continue;
    }
    const missing = SPAN_KEYS.filter((k) => !hasOwn(v, k));
    if (missing.length > 0) {
      for (const k of missing) problems.push(`${sp.name}: missing field ${q(k)}`);
      continue;
    }
    if (typeof v.text !== 'string') problems.push(`${sp.name}.text: expected a string`);
    if (!isInt(v.start)) problems.push(`${sp.name}.start: expected an integer`);
    if (!isInt(v.end)) problems.push(`${sp.name}.end: expected an integer`);
  }

  if (hasOwn(obj, 'span_status') && (mode === 'proposal' || hasSpanStatuses)) {
    const ss = obj.span_status;
    if (!isRecord(ss)) {
      problems.push('span_status: expected an object');
    } else {
      for (const [k, v] of Object.entries(ss)) {
        if (typeof v !== 'string') problems.push(`span_status.${k}: expected a string`);
      }
    }
  }
  return problems;
}

/** Why `t` is not a valid value of span `name` in `text`, or null. Quet's `spanProblem` wording. */
function spanProblem(name: string, t: Span, text: string): string | null {
  if (t.text === '') return `${name}.text: expected a non-empty string`;
  if (isPadded(t.text)) return `${name}.text: has leading or trailing whitespace`;
  const n = cpLength(text);
  if (t.start < 0) return `${name}: span start ${t.start} is negative`;
  if (t.end <= t.start) return `${name}: span [${t.start},${t.end}) is empty`;
  if (t.end > n) return `${name}: span end ${t.end} is beyond the text length ${n}`;
  const got = cpSlice(text, t.start, t.end);
  if (got !== t.text) return `${name}: text[${t.start}:${t.end}] is ${q(got)}, not ${q(t.text)}`;
  return null;
}

/** Semantic checks on a shape-valid label/proposal, in Quet's order. */
function semanticProblems(schema: Schema, text: string, obj: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const status = obj.annotation_status as string;
  const type = typeof obj.type === 'string' ? obj.type : null;

  if (!schema.statuses.some((s) => s.name === status)) {
    problems.push(`annotation_status: ${q(status)} is not one of ${list(schema.statuses.map((s) => s.name))}`);
  }
  if (type === null) {
    if (status === COMPLETE) problems.push(`type: required when annotation_status is ${q(COMPLETE)}`);
  } else if (!schema.types.some((t) => t.name === type)) {
    problems.push(`type: ${q(type)} is not one of ${list(schema.types.map((t) => t.name))}`);
  }

  for (const sp of schema.spans) {
    const v = obj[sp.name];
    if (!isRecord(v)) continue; // absent or null
    const problem = spanProblem(sp.name, v as unknown as Span, text);
    if (problem !== null) problems.push(problem);
    if (isNullFor(sp, type)) problems.push(`${sp.name}: must be null for type ${q(type ?? '')}`);
  }

  const ss = obj.span_status;
  if (isRecord(ss)) {
    for (const sp of schema.spans) {
      if (!hasOwn(ss, sp.name)) continue;
      const st = ss[sp.name] as string;
      if (sp.statuses.length === 0) {
        problems.push(`span_status.${sp.name}: span declares no statuses`);
      } else if (!sp.statuses.includes(st)) {
        problems.push(`span_status.${sp.name}: ${q(st)} is not one of ${list(sp.statuses)}`);
      }
      if (isNullFor(sp, type)) {
        problems.push(`span_status.${sp.name}: must be absent for type ${q(type ?? '')}`);
      }
    }
    const declared = new Set(schema.spans.map((sp) => sp.name));
    for (const k of Object.keys(ss).sort()) {
      if (!declared.has(k)) problems.push(`span_status.${k}: not a declared span`);
    }
  }
  return problems;
}

/** Strict Quet validation of a label against the record text. Error wording follows Quet docs,
 *  problems joined with "; ". */
export function validateLabel(
  schema: Schema,
  text: string,
  label: unknown,
): { ok: true; label: Label } | { ok: false; error: string } {
  if (!isRecord(label)) return { ok: false, error: 'label: expected an object' };
  const shape = shapeProblems(schema, label, 'label');
  if (shape.length > 0) return { ok: false, error: shape.join('; ') };
  const problems = semanticProblems(schema, text, label);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  return { ok: true, label: label as Label };
}

/** Display-time proposal check (Quet: "⚠ invalid: <reason>"). Extra members are ignored; an absent
 *  span key counts as null. */
export function validateProposal(
  schema: Schema,
  text: string,
  proposal: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(proposal)) return { ok: false, error: 'proposal: expected an object' };
  const shape = shapeProblems(schema, proposal, 'proposal');
  if (shape.length > 0) return { ok: false, error: shape.join('; ') };
  const problems = semanticProblems(schema, text, proposal);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  return { ok: true };
}
