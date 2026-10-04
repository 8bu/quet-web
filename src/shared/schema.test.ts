import { describe, expect, it } from 'vitest';
import {
  SchemaError,
  cpLength,
  cpSlice,
  cpToUtf16,
  isNullFor,
  normalizeLabel,
  parseSchema,
  utf16ToCp,
  validateLabel,
  validateProposal,
  wordRanges,
} from './schema';
import type { Label, Schema } from './schema';

// examples/annotation/schema.yaml as the Quet CLI normalizes it (implicit target).
const sentimentJson = {
  version: 'sentiment-v1',
  types: [
    { name: 'positive', description: 'The writer is pleased with the aspect named by the target.' },
    { name: 'negative', description: 'The writer is unhappy with the aspect named by the target.' },
    { name: 'mixed', description: 'Both praise and complaint about the same aspect.' },
    { name: 'neutral', description: 'A factual statement with no sentiment; there is nothing to point at.' },
  ],
  statuses: [
    { name: 'complete', description: 'Type and target confidently determined.' },
    { name: 'uncertain', description: 'The text does not settle the type or the target.' },
    { name: 'skipped', description: 'Not a review, or not worth labelling.' },
  ],
  null_label_statuses: ['skipped'],
  implicit_target: true,
  spans: [{ name: 'target', description: '', null_for_types: ['neutral'], statuses: [] }],
};

// examples/annotation/schema-multispan.yaml.
const expenseJson = {
  version: 'expense-v1',
  types: [
    { name: 'expense', description: 'Money the writer paid out.' },
    { name: 'income', description: 'Money the writer received.' },
    { name: 'transfer', description: "Money moved between the writer's own accounts or people; there is no counterparty." },
  ],
  statuses: [
    { name: 'complete', description: 'Type and every span confidently determined.' },
    { name: 'uncertain', description: 'The text does not settle the type or a span.' },
    { name: 'skipped', description: 'Not a money note, or not worth labelling.' },
  ],
  null_label_statuses: ['skipped'],
  implicit_target: false,
  spans: [
    { name: 'target', description: 'Counterparty. Minimal span as typed.', null_for_types: ['transfer'], statuses: [] },
    {
      name: 'value',
      description: 'Monetary amount. Exact substring, no normalization.',
      null_for_types: [],
      statuses: ['complete', 'uncertain'],
    },
  ],
};

// Expense schema plus a `gift` type whose value (which declares statuses) must be null.
const giftJson = {
  ...expenseJson,
  types: [...expenseJson.types, { name: 'gift', description: 'Given away.' }],
  spans: [
    expenseJson.spans[0],
    { ...expenseJson.spans[1], null_for_types: ['gift'] },
  ],
};

const sentiment: Schema = parseSchema(sentimentJson);
const expense: Schema = parseSchema(expenseJson);
const gift: Schema = parseSchema(giftJson);

const PHO = 'Phở ở đây ngon tuyệt, nước dùng rất đậm đà';
const MS1 = 'Mua sữa ở Vinamilk hết 500k';
const MS2 = 'Chuyển khoản 2tr cho mẹ';

function errorOf(r: { ok: true } | { ok: true; label: Label } | { ok: false; error: string }): string {
  if (r.ok) throw new Error('expected a validation error, got ok');
  return r.error;
}

describe('test fixtures', () => {
  it('use precomposed (NFC) Vietnamese, as in the Quet docs', () => {
    for (const s of [PHO, MS1, MS2]) expect(s.normalize('NFC')).toBe(s);
  });
});

describe('code-point helpers', () => {
  it('match the offsets documented by Quet', () => {
    expect(cpLength(PHO)).toBe(42);
    expect(PHO.length).toBe(42);
    expect(cpSlice(PHO, 0, 3)).toBe('Phở');
    expect(cpSlice(PHO, 22, 31)).toBe('nước dùng');
  });

  it('treat an astral character (🍜) as one code point and two UTF-16 units', () => {
    const t = 'a🍜b';
    expect(t.length).toBe(4);
    expect(cpLength(t)).toBe(3);
    expect(utf16ToCp(t, 0)).toBe(0);
    expect(utf16ToCp(t, 1)).toBe(1);
    expect(utf16ToCp(t, 2)).toBe(1); // inside the surrogate pair: the code point containing it
    expect(utf16ToCp(t, 3)).toBe(2);
    expect(utf16ToCp(t, 4)).toBe(3);
    expect(utf16ToCp(t, 99)).toBe(3);
    expect(cpToUtf16(t, 0)).toBe(0);
    expect(cpToUtf16(t, 1)).toBe(1);
    expect(cpToUtf16(t, 2)).toBe(3);
    expect(cpToUtf16(t, 3)).toBe(4);
    expect(cpToUtf16(t, 99)).toBe(4);
    expect(cpSlice(t, 1, 2)).toBe('🍜');
    expect(cpSlice(t, 2, 3)).toBe('b');
    expect(cpSlice(t, 0, 3)).toBe(t);
    expect(cpSlice(t, 2, 2)).toBe('');
    expect(cpSlice(t, 3, 1)).toBe('');
    expect(cpSlice(t, 1, 99)).toBe('🍜b');
  });

  it('slices Japanese text with a trailing emoji', () => {
    const t = 'ラーメンが最高でした 🍜';
    expect(cpLength(t)).toBe(12);
    expect(t.length).toBe(13);
    expect(cpSlice(t, 11, 12)).toBe('🍜');
    expect(cpSlice(t, 0, 4)).toBe('ラーメン');
  });

  it('count combining marks as separate code points', () => {
    const decomposed = 'Pho\u031b\u0309 x'; // "Phở" as o + horn + hook above
    expect(cpLength(decomposed)).toBe(7);
    expect(cpLength('Phở x')).toBe(5);
    expect(cpSlice(decomposed, 0, 3)).toBe('Pho');
    expect(cpSlice(decomposed, 0, 5)).toBe('Pho\u031b\u0309');
    expect(utf16ToCp(decomposed, 5)).toBe(5);
    expect(cpToUtf16(decomposed, 6)).toBe(6);
  });

  it('count a lone surrogate as one code point', () => {
    expect(cpLength('a\ud83cb')).toBe(3);
    expect(cpSlice('a\ud83cb', 1, 2)).toBe('\ud83c');
  });
});

describe('isNullFor', () => {
  it('is true only for a listed type', () => {
    const target = sentiment.spans[0];
    if (!target) throw new Error('missing span');
    expect(isNullFor(target, 'neutral')).toBe(true);
    expect(isNullFor(target, 'positive')).toBe(false);
    expect(isNullFor(target, null)).toBe(false);
  });
});

describe('parseSchema', () => {
  it('accepts the implicit-target sentiment schema', () => {
    expect(sentiment).toEqual(sentimentJson);
    expect(sentiment.spans).toEqual([
      { name: 'target', description: '', null_for_types: ['neutral'], statuses: [] },
    ]);
  });

  it('accepts the multi-span schema and keeps order', () => {
    expect(expense).toEqual(expenseJson);
    expect(expense.spans.map((s) => s.name)).toEqual(['target', 'value']);
    expect(expense.types.map((t) => t.name)).toEqual(['expense', 'income', 'transfer']);
  });

  it('treats a missing version as null and drops unknown keys', () => {
    const { version: _version, ...rest } = sentimentJson;
    const parsed = parseSchema({ ...rest, extra: 1 });
    expect(parsed.version).toBeNull();
    expect(Object.keys(parsed)).toEqual([
      'version',
      'types',
      'statuses',
      'null_label_statuses',
      'implicit_target',
      'spans',
    ]);
  });

  const cases: Array<[string, (s: Record<string, unknown>) => unknown, string]> = [
    ['non-object', () => 'nope', 'schema: expected an object'],
    ['numeric version', (s) => ({ ...s, version: 3 }), 'version: expected a string or null'],
    ['empty types', (s) => ({ ...s, types: [] }), 'types: expected a non-empty array'],
    ['missing statuses', (s) => ({ ...s, statuses: undefined }), 'statuses: expected a non-empty array'],
    ['type without description', (s) => ({ ...s, types: [{ name: 'a' }] }), 'types[0] ("a").description: expected a string'],
    ['empty type name', (s) => ({ ...s, types: [{ name: '', description: '' }] }), 'types[0].name: expected a non-empty string'],
    [
      'duplicate type',
      (s) => ({ ...s, types: [{ name: 'a', description: '' }, { name: 'a', description: '' }] }),
      'types: duplicate name "a"',
    ],
    ['unknown null label status', (s) => ({ ...s, null_label_statuses: ['ghost'] }), 'null_label_statuses: "ghost" is not a declared status'],
    ['missing null label statuses', (s) => ({ ...s, null_label_statuses: undefined }), 'null_label_statuses: required (the default must already be applied)'],
    ['non-boolean implicit_target', (s) => ({ ...s, implicit_target: 'yes' }), 'implicit_target: expected a boolean'],
    ['empty spans', (s) => ({ ...s, spans: [] }), 'spans: expected a non-empty array'],
    [
      'reserved span name',
      (s) => ({ ...s, implicit_target: false, spans: [{ name: 'note', description: '', null_for_types: [], statuses: [] }] }),
      'spans[0].name: "note" is reserved',
    ],
    [
      'reserved span name span_status',
      (s) => ({ ...s, implicit_target: false, spans: [{ name: 'span_status', description: '', null_for_types: [], statuses: [] }] }),
      'spans[0].name: "span_status" is reserved',
    ],
    [
      'badly formed span name',
      (s) => ({ ...s, implicit_target: false, spans: [{ name: '1x', description: '', null_for_types: [], statuses: [] }] }),
      'spans[0].name: "1x" must match ^[A-Za-z_][A-Za-z0-9_]*$',
    ],
    [
      'duplicate span name',
      (s) => ({
        ...s,
        implicit_target: false,
        spans: [
          { name: 'a', description: '', null_for_types: [], statuses: [] },
          { name: 'a', description: '', null_for_types: [], statuses: [] },
        ],
      }),
      'spans: duplicate span "a"',
    ],
    [
      'span without description',
      (s) => ({ ...s, spans: [{ name: 'target', null_for_types: [], statuses: [] }] }),
      'spans.target.description: expected a string',
    ],
    [
      'undeclared null_for_types entry',
      (s) => ({ ...s, spans: [{ name: 'target', description: '', null_for_types: ['ghost'], statuses: [] }] }),
      'spans.target.null_for_types: "ghost" is not a declared type',
    ],
    [
      'duplicate null_for_types entry',
      (s) => ({ ...s, spans: [{ name: 'target', description: '', null_for_types: ['neutral', 'neutral'], statuses: [] }] }),
      'spans.target.null_for_types: duplicate type "neutral"',
    ],
    [
      'undeclared span status',
      (s) => ({ ...s, spans: [{ name: 'target', description: '', null_for_types: [], statuses: ['ghost'] }] }),
      'spans.target.statuses: "ghost" is not a declared status',
    ],
    [
      'implicit_target with two spans',
      (s) => ({
        ...s,
        spans: [
          { name: 'target', description: '', null_for_types: [], statuses: [] },
          { name: 'other', description: '', null_for_types: [], statuses: [] },
        ],
      }),
      'implicit_target: requires exactly one span named "target"',
    ],
    [
      'implicit_target with a differently named span',
      (s) => ({ ...s, spans: [{ name: 'amount', description: '', null_for_types: [], statuses: [] }] }),
      'implicit_target: requires exactly one span named "target"',
    ],
  ];

  it.each(cases)('rejects %s', (_name, mutate, message) => {
    const input = mutate(structuredClone(sentimentJson));
    expect(() => parseSchema(input)).toThrow(SchemaError);
    expect(() => parseSchema(input)).toThrow(message);
  });
});

describe('validateLabel: implicit-target sentiment schema', () => {
  const rv002 = {
    id: 'rv-002',
    annotation_status: 'complete',
    type: 'positive',
    target: { text: 'nước dùng', start: 22, end: 31 },
  };

  it('accepts the docs example and returns the label', () => {
    expect(validateLabel(sentiment, PHO, rv002)).toEqual({ ok: true, label: rv002 });
  });

  it('accepts a null target on a null-target type and on a skip', () => {
    expect(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'complete', type: 'neutral', target: null }).ok).toBe(true);
    expect(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'skipped', type: null, target: null }).ok).toBe(true);
    expect(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', type: null, target: null }).ok).toBe(true);
  });

  it('does not reject a type on a null_label_status label (cleaned up on save, not a load error)', () => {
    const r = validateLabel(sentiment, PHO, {
      id: 'a',
      annotation_status: 'skipped',
      type: 'positive',
      target: { text: 'Phở', start: 0, end: 3 },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a note', () => {
    expect(validateLabel(sentiment, PHO, { ...rv002, note: 'praised broth' }).ok).toBe(true);
  });

  it('rejects an undeclared status and type', () => {
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'done', type: null, target: null }))).toBe(
      'annotation_status: "done" is not one of [complete, uncertain, skipped]',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', type: 'lend', target: null }))).toBe(
      'type: "lend" is not one of [positive, negative, mixed, neutral]',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', type: '', target: null }))).toBe(
      'type: "" is not one of [positive, negative, mixed, neutral]',
    );
  });

  it('requires a type when complete', () => {
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'complete', type: null, target: null }))).toBe(
      'type: required when annotation_status is "complete"',
    );
  });

  it('rejects a target on a null-target type whatever the status', () => {
    const target = { text: 'Phở', start: 0, end: 3 };
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'complete', type: 'neutral', target }))).toBe(
      'target: must be null for type "neutral"',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', type: 'neutral', target }))).toBe(
      'target: must be null for type "neutral"',
    );
  });

  it('rejects spans outside the text', () => {
    const label = (target: unknown) => ({ id: 'a', annotation_status: 'complete', type: 'positive', target });
    expect(errorOf(validateLabel(sentiment, PHO, label({ text: 'đà', start: 40, end: 45 })))).toBe(
      'target: span end 45 is beyond the text length 42',
    );
    expect(errorOf(validateLabel(sentiment, PHO, label({ text: 'Phở', start: -1, end: 2 })))).toBe(
      'target: span start -1 is negative',
    );
    expect(errorOf(validateLabel(sentiment, PHO, label({ text: 'Phở', start: 3, end: 3 })))).toBe(
      'target: span [3,3) is empty',
    );
    expect(errorOf(validateLabel(sentiment, PHO, label({ text: 'Phở', start: 5, end: 3 })))).toBe(
      'target: span [5,3) is empty',
    );
  });

  it('rejects UTF-16 offsets where code-point offsets are required', () => {
    const text = 'I 🍜 pho';
    const ok = { id: 'a', annotation_status: 'complete', type: 'positive', target: { text: 'pho', start: 4, end: 7 } };
    expect(validateLabel(sentiment, text, ok).ok).toBe(true);
    const utf16 = { ...ok, target: { text: 'pho', start: 5, end: 8 } };
    expect(errorOf(validateLabel(sentiment, text, utf16))).toBe('target: span end 8 is beyond the text length 7');
  });

  it('rejects a span whose text does not match the offsets', () => {
    const r = validateLabel(sentiment, 'I 🍜 pho', {
      id: 'a',
      annotation_status: 'complete',
      type: 'positive',
      target: { text: 'pho', start: 3, end: 6 },
    });
    expect(errorOf(r)).toBe('target: text[3:6] is " ph", not "pho"');
  });

  it('rejects empty text and leading or trailing whitespace in the span text', () => {
    const label = (text: string, start: number, end: number) => ({
      id: 'a',
      annotation_status: 'complete',
      type: 'positive',
      target: { text, start, end },
    });
    expect(errorOf(validateLabel(sentiment, PHO, label('', 0, 3)))).toBe('target.text: expected a non-empty string');
    expect(errorOf(validateLabel(sentiment, PHO, label('Phở ', 0, 4)))).toBe(
      'target.text: has leading or trailing whitespace',
    );
    expect(errorOf(validateLabel(sentiment, PHO, label(' ở', 3, 5)))).toBe(
      'target.text: has leading or trailing whitespace',
    );
    expect(errorOf(validateLabel(sentiment, 'a\u00a0b', label('\u00a0b', 1, 3)))).toBe(
      'target.text: has leading or trailing whitespace',
    );
    expect(errorOf(validateLabel(sentiment, 'x 🍜 ', label('🍜 ', 2, 4)))).toBe(
      'target.text: has leading or trailing whitespace',
    );
  });

  it('rejects unknown top-level keys, including span_status when no span declares statuses', () => {
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, confidence: 1 }))).toBe('unknown field(s) ["confidence"]');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, span_status: {} }))).toBe('unknown field(s) ["span_status"]');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, zeta: 1, alpha: 2 }))).toBe(
      'unknown field(s) ["alpha" "zeta"]',
    );
  });

  it('rejects unknown keys inside a span object', () => {
    const label = { ...rv002, target: { text: 'nước dùng', start: 22, end: 31, score: 1 } };
    expect(errorOf(validateLabel(sentiment, PHO, label))).toBe('target: unknown field(s) ["score"]');
  });

  it('rejects malformed shapes', () => {
    expect(errorOf(validateLabel(sentiment, PHO, null))).toBe('label: expected an object');
    expect(errorOf(validateLabel(sentiment, PHO, []))).toBe('label: expected an object');
    expect(errorOf(validateLabel(sentiment, PHO, { id: 'a', annotation_status: 'skipped', type: null }))).toBe(
      'missing field "target"',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { annotation_status: 'skipped', type: null, target: null }))).toBe(
      'missing field "id"',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, id: '' }))).toBe('id: expected a non-empty string');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, type: 3 }))).toBe('type: expected a string or null');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, annotation_status: null }))).toBe(
      'annotation_status: expected a string',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, note: 1 }))).toBe('note: expected a string');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, target: 'Nam' }))).toBe('target: expected an object or null');
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, target: { text: 'Phở', start: 0 } }))).toBe(
      'target: missing field "end"',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, target: { text: 'Phở', start: 0.5, end: 3 } }))).toBe(
      'target.start: expected an integer',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, target: { text: 'Phở', start: 0, end: null } }))).toBe(
      'target.end: expected an integer',
    );
    expect(errorOf(validateLabel(sentiment, PHO, { ...rv002, target: { text: 1, start: 0, end: 3 } }))).toBe(
      'target.text: expected a string',
    );
  });

  it('lists every semantic problem, joined with "; "', () => {
    const r = validateLabel(sentiment, PHO, {
      id: 'a',
      annotation_status: 'nope',
      type: 'gift',
      target: { text: 'Phở', start: 1, end: 3 },
    });
    expect(errorOf(r)).toBe(
      'annotation_status: "nope" is not one of [complete, uncertain, skipped]; ' +
        'type: "gift" is not one of [positive, negative, mixed, neutral]; ' +
        'target: text[1:3] is "hở", not "Phở"',
    );
  });
});

describe('validateLabel: multi-span schema', () => {
  const ms001 = {
    id: 'ms-001',
    annotation_status: 'complete',
    type: 'expense',
    target: { text: 'Vinamilk', start: 10, end: 18 },
    value: { text: '500k', start: 23, end: 27 },
    span_status: { value: 'complete' },
  };

  it('accepts the docs examples', () => {
    expect(validateLabel(expense, MS1, ms001)).toEqual({ ok: true, label: ms001 });
    const ms002 = {
      id: 'ms-002',
      annotation_status: 'uncertain',
      type: 'transfer',
      target: null,
      value: { text: '2tr', start: 13, end: 16 },
      span_status: { value: 'uncertain' },
    };
    expect(validateLabel(expense, MS2, ms002).ok).toBe(true);
    const ms005 = { id: 'ms-005', annotation_status: 'skipped', type: null, target: null, value: null };
    expect(validateLabel(expense, 'asdf test test', ms005).ok).toBe(true);
  });

  it('does not require a span_status entry', () => {
    const { span_status: _spanStatus, ...bare } = ms001;
    expect(validateLabel(expense, MS1, bare).ok).toBe(true);
  });

  it('requires every declared span key', () => {
    const { value: _value, ...noValue } = ms001;
    expect(errorOf(validateLabel(expense, MS1, noValue))).toBe('missing field "value"');
  });

  it('rejects an unknown span key', () => {
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, price: null }))).toBe('unknown field(s) ["price"]');
  });

  it('prefixes span problems with the span name', () => {
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, value: { text: ' 500k', start: 22, end: 27 } }))).toBe(
      'value.text: has leading or trailing whitespace',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, value: { text: '500k', start: 30, end: 34 } }))).toBe(
      'value: span end 34 is beyond the text length 27',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, value: { text: '500k', start: 22, end: 26 } }))).toBe(
      'value: text[22:26] is " 500", not "500k"',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, value: '500k' }))).toBe('value: expected an object or null');
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, target: { text: 'Vinamilk', start: 10, end: 18, x: 1 } }))).toBe(
      'target: unknown field(s) ["x"]',
    );
  });

  it('rejects a span set for a type that must leave it null', () => {
    const label = {
      id: 'm',
      annotation_status: 'complete',
      type: 'transfer',
      target: { text: 'Chuyển', start: 0, end: 6 },
      value: null,
    };
    expect(errorOf(validateLabel(expense, MS2, label))).toBe('target: must be null for type "transfer"');
  });

  it('checks span_status members', () => {
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, span_status: { value: 'skipped' } }))).toBe(
      'span_status.value: "skipped" is not one of [complete, uncertain]',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, span_status: { value: 'complete', target: 'complete' } }))).toBe(
      'span_status.target: span declares no statuses',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, span_status: { value: 'complete', ghost: 'x' } }))).toBe(
      'span_status.ghost: not a declared span',
    );
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, span_status: 'complete' }))).toBe('span_status: expected an object');
    expect(errorOf(validateLabel(expense, MS1, { ...ms001, span_status: { value: 1 } }))).toBe(
      'span_status.value: expected a string',
    );
  });

  it('rejects a span status on a span that is null for the type', () => {
    const label = {
      id: 'g',
      annotation_status: 'complete',
      type: 'gift',
      target: { text: 'Vinamilk', start: 10, end: 18 },
      value: null,
      span_status: { value: 'complete' },
    };
    expect(errorOf(validateLabel(gift, MS1, label))).toBe('span_status.value: must be absent for type "gift"');
  });

  it('orders problems: status, type, spans in schema order, then span_status', () => {
    const label = {
      id: 'g',
      annotation_status: 'complete',
      type: 'gift',
      target: { text: 'Vinamilk', start: 10, end: 18 },
      value: { text: '500k', start: 23, end: 27 },
      span_status: { value: 'zzz', target: 'complete', ghost: 'x' },
    };
    expect(errorOf(validateLabel(gift, MS1, label))).toBe(
      'value: must be null for type "gift"; ' +
        'span_status.target: span declares no statuses; ' +
        'span_status.value: "zzz" is not one of [complete, uncertain]; ' +
        'span_status.value: must be absent for type "gift"; ' +
        'span_status.ghost: not a declared span',
    );
  });
});

describe('normalizeLabel', () => {
  const base = {
    id: 'ms-001',
    annotation_status: 'complete',
    type: 'expense',
    target: { text: 'Vinamilk', start: 10, end: 18 },
    value: { text: '500k', start: 23, end: 27 },
  };

  it('fills the default span status (first listed) in canonical key order', () => {
    const out = normalizeLabel(expense, { ...base, note: '' });
    expect(out).toEqual({ ...base, span_status: { value: 'complete' } });
    expect(Object.keys(out)).toEqual(['id', 'annotation_status', 'type', 'target', 'value', 'span_status']);
  });

  it('puts keys in canonical order whatever the input order, note last', () => {
    const shuffled = {
      note: 'n',
      span_status: { value: 'uncertain' },
      value: base.value,
      type: 'expense',
      target: base.target,
      annotation_status: 'complete',
      id: 'ms-001',
    };
    const out = normalizeLabel(expense, shuffled);
    expect(Object.keys(out)).toEqual(['id', 'annotation_status', 'type', 'target', 'value', 'span_status', 'note']);
    expect(out.span_status).toEqual({ value: 'uncertain' });
    expect(out.note).toBe('n');
  });

  it('keeps a valid submitted span status and replaces an invalid one with the default', () => {
    expect(normalizeLabel(expense, { ...base, span_status: { value: 'uncertain' } }).span_status).toEqual({ value: 'uncertain' });
    expect(normalizeLabel(expense, { ...base, span_status: { value: 'skipped' } }).span_status).toEqual({ value: 'complete' });
  });

  it('keeps the span status of a null span, and for a null type', () => {
    const nullValue = normalizeLabel(expense, { ...base, value: null, span_status: { value: 'uncertain' } });
    expect(nullValue.value).toBeNull();
    expect(nullValue.span_status).toEqual({ value: 'uncertain' });
    const noType = normalizeLabel(expense, {
      id: 'a',
      annotation_status: 'uncertain',
      type: null,
      target: null,
      value: null,
    });
    expect(noType).toEqual({
      id: 'a',
      annotation_status: 'uncertain',
      type: null,
      target: null,
      value: null,
      span_status: { value: 'complete' },
    });
  });

  it('drops span statuses of spans that are null for the type, and an empty span_status', () => {
    const out = normalizeLabel(gift, {
      id: 'g',
      annotation_status: 'complete',
      type: 'gift',
      target: base.target,
      value: null,
      span_status: { value: 'uncertain' },
    });
    expect(out).toEqual({ id: 'g', annotation_status: 'complete', type: 'gift', target: base.target, value: null });
    expect('span_status' in out).toBe(false);
  });

  it('drops statuses declared for spans without statuses', () => {
    const out = normalizeLabel(expense, { ...base, span_status: { value: 'complete', target: 'complete', ghost: 'x' } });
    expect(out.span_status).toEqual({ value: 'complete' });
  });

  it('clears type, every span and span_status for a null_label_status, keeping a note', () => {
    const out = normalizeLabel(expense, {
      ...base,
      annotation_status: 'skipped',
      span_status: { value: 'uncertain' },
      note: 'not money',
    });
    expect(out).toEqual({
      id: 'ms-001',
      annotation_status: 'skipped',
      type: null,
      target: null,
      value: null,
      note: 'not money',
    });
    expect(Object.keys(out)).toEqual(['id', 'annotation_status', 'type', 'target', 'value', 'note']);
  });

  it('clears the sentiment target on skip and leaves other statuses alone', () => {
    const target = { text: 'Phở', start: 0, end: 3 };
    expect(normalizeLabel(sentiment, { id: 'a', annotation_status: 'skipped', type: 'positive', target })).toEqual({
      id: 'a',
      annotation_status: 'skipped',
      type: null,
      target: null,
    });
    expect(normalizeLabel(sentiment, { id: 'a', annotation_status: 'uncertain', type: 'positive', target })).toEqual({
      id: 'a',
      annotation_status: 'uncertain',
      type: 'positive',
      target,
    });
  });

  it('treats an absent span key as null and never adds span_status without span statuses', () => {
    const out = normalizeLabel(sentiment, { id: 'a', annotation_status: 'complete', type: 'neutral' });
    expect(out).toEqual({ id: 'a', annotation_status: 'complete', type: 'neutral', target: null });
  });

  it('does not mutate its input', () => {
    const input = { ...base, annotation_status: 'skipped', span_status: { value: 'uncertain' } };
    const snapshot = structuredClone(input);
    normalizeLabel(expense, input);
    expect(input).toEqual(snapshot);
  });

  it('produces labels that pass validateLabel', () => {
    const out = normalizeLabel(expense, { ...base, span_status: { value: 'bogus' } });
    expect(validateLabel(expense, MS1, out)).toEqual({ ok: true, label: out });
  });
});

describe('validateProposal', () => {
  it('accepts a proposal with extra members', () => {
    const p = {
      id: 'rv-002',
      annotation_status: 'complete',
      type: 'positive',
      target: { text: 'nước dùng', start: 22, end: 31 },
      note: 'praised broth',
      confidence: 0.91,
      reason: 'explicit praise of the broth',
      model: 'x',
    };
    expect(validateProposal(sentiment, PHO, p)).toEqual({ ok: true });
  });

  it('treats an absent span key as null', () => {
    expect(validateProposal(sentiment, PHO, { id: 'rv-003', annotation_status: 'uncertain', confidence: 0.35 })).toEqual({ ok: true });
    expect(validateProposal(expense, MS1, { id: 'a', annotation_status: 'complete', type: 'expense' })).toEqual({ ok: true });
  });

  it('rejects an undeclared status or type', () => {
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'maybe' }))).toBe(
      'annotation_status: "maybe" is not one of [complete, uncertain, skipped]',
    );
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'complete', type: 'loan' }))).toBe(
      'type: "loan" is not one of [positive, negative, mixed, neutral]',
    );
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'complete' }))).toBe(
      'type: required when annotation_status is "complete"',
    );
  });

  it('rejects a span that is not a valid substring of the text', () => {
    const p = { id: 'a', annotation_status: 'complete', type: 'positive', target: { text: 'Tam', start: 0, end: 3 } };
    expect(errorOf(validateProposal(sentiment, PHO, p))).toBe('target: text[0:3] is "Phở", not "Tam"');
    expect(errorOf(validateProposal(sentiment, PHO, { ...p, target: { text: 'đà', start: 40, end: 50 } }))).toBe(
      'target: span end 50 is beyond the text length 42',
    );
  });

  it('rejects a span set for a null-for-type type', () => {
    const p = { id: 'a', annotation_status: 'complete', type: 'neutral', target: { text: 'Phở', start: 0, end: 3 } };
    expect(errorOf(validateProposal(sentiment, PHO, p))).toBe('target: must be null for type "neutral"');
  });

  it('rejects undeclared span statuses', () => {
    const p = { id: 'a', annotation_status: 'complete', type: 'expense', span_status: { value: 'zzz' } };
    expect(errorOf(validateProposal(expense, MS1, p))).toBe('span_status.value: "zzz" is not one of [complete, uncertain]');
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', span_status: { target: 'x' } }))).toBe(
      'span_status.target: span declares no statuses',
    );
  });

  it('rejects malformed shapes', () => {
    expect(errorOf(validateProposal(sentiment, PHO, 'x'))).toBe('proposal: expected an object');
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a' }))).toBe('missing field "annotation_status"');
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', confidence: 2 }))).toBe(
      'confidence: expected a number from 0 to 1',
    );
    expect(errorOf(validateProposal(sentiment, PHO, { id: 'a', annotation_status: 'uncertain', target: 'x' }))).toBe(
      'target: expected an object or null',
    );
  });
});

describe('wordRanges', () => {
  it('finds Vietnamese words by code point', () => {
    expect(wordRanges(PHO)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 5 },
      { start: 6, end: 9 },
      { start: 10, end: 14 },
      { start: 15, end: 20 },
      { start: 22, end: 26 },
      { start: 27, end: 31 },
      { start: 32, end: 35 },
      { start: 36, end: 39 },
      { start: 40, end: 42 },
    ]);
  });

  it('finds German words, digits and umlauts', () => {
    expect(wordRanges('Über 3 Straßen, größer!')).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 6 },
      { start: 7, end: 14 },
      { start: 16, end: 22 },
    ]);
  });

  it('keeps combining marks inside a word', () => {
    expect(wordRanges('Pho\u031b\u0309 x')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 7 },
    ]);
  });

  it('counts an emoji as one non-word code point', () => {
    expect(wordRanges('ラーメン 🍜 ok')).toEqual([
      { start: 0, end: 4 },
      { start: 7, end: 9 },
    ]);
  });

  it('returns nothing for empty or punctuation-only text', () => {
    expect(wordRanges('')).toEqual([]);
    expect(wordRanges(' ,.!? 🍜')).toEqual([]);
  });
});
