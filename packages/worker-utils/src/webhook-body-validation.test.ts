import { describe, expect, it } from 'vitest';
import {
  webhookBodySchema,
  validateWebhookBody,
  WEBHOOK_BODY_SCHEMA_EXAMPLE,
} from './webhook-body-validation';

const nestedSchema = webhookBodySchema.parse({
  type: 'object',
  properties: {
    event: { type: 'string', enum: ['issue.opened', 'issue.closed'] },
    changes: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 5 } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  },
  required: ['event', 'changes'],
  additionalProperties: false,
});

describe('webhook body validation', () => {
  it('accepts nested payloads and preserves input and schema values', () => {
    const raw = ' { "event" : "issue.opened", "changes": [{"count":2}] }\n';
    const before = JSON.stringify(nestedSchema);
    expect(validateWebhookBody(nestedSchema, raw)).toEqual({ valid: true });
    expect(raw).toBe(' { "event" : "issue.opened", "changes": [{"count":2}] }\n');
    expect(JSON.stringify(nestedSchema)).toBe(before);
    expect(webhookBodySchema.safeParse(nestedSchema).success).toBe(true);
  });

  it.each([
    '{',
    '{}',
    '{"event":"unknown","changes":[{"count":2}]}',
    '{"event":"issue.closed","changes":[{"count":"2"}]}',
    '{"event":"issue.closed","changes":[{"count":0}]}',
    '{"event":"issue.closed","changes":[{"count":6}]}',
    '{"event":"issue.closed","changes":[]}',
    '{"event":"issue.closed","changes":[{"count":2,"extra":"private-value"}]}',
  ])('rejects invalid JSON, types, ranges, enums and additional properties: %s', raw => {
    const result = validateWebhookBody(nestedSchema, raw);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(result.issues)).not.toContain('private-value');
    for (const issue of result.issues) {
      expect(issue.path.length).toBeLessThanOrEqual(256);
      expect(issue.message.length).toBeLessThan(100);
    }
  });

  it('applies enums, const, lengths, unique items and compositions without coercion', () => {
    const schema = webhookBodySchema.parse({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 5 },
        values: { type: 'array', uniqueItems: true, items: { enum: ['a', 'b'] } },
        enabled: { const: true },
        score: { allOf: [{ type: 'number' }, { multipleOf: 2 }], not: { const: 0 } },
        choice: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        alternative: { anyOf: [{ const: 2 }, { const: 'two' }] },
      },
      required: ['name', 'values', 'enabled', 'score', 'choice', 'alternative'],
    });
    const valid = {
      name: 'abc',
      values: ['a', 'b'],
      enabled: true,
      score: 2,
      choice: null,
      alternative: 'two',
    };
    expect(validateWebhookBody(schema, JSON.stringify(valid)).valid).toBe(true);
    for (const change of [
      { name: 'a' },
      { values: ['a', 'a'] },
      { enabled: false },
      { score: 0 },
      { score: '2' },
      { choice: 2 },
      { alternative: false },
    ]) {
      expect(validateWebhookBody(schema, JSON.stringify({ ...valid, ...change })).valid).toBe(
        false
      );
    }
  });

  it.each([
    null,
    [],
    true,
    { type: 'made-up' },
    { properties: { nested: { format: 'email' } } },
    { pattern: '[' },
    { pattern: '\\a' },
    { $ref: 'https://example.com/schema' },
    { $ref: '#' },
    { default: 'secret' },
    { minLength: -1 },
    { multipleOf: 0 },
    { required: 'name' },
    { additionalProperties: 'no' },
  ])('rejects malformed or unsupported schemas: %j', schema => {
    expect(webhookBodySchema.safeParse(schema).success).toBe(false);
  });

  it('bounds schema bytes, depth, and nodes before recursive parsing', () => {
    expect(webhookBodySchema.safeParse({ enum: ['a'.repeat(32769)] }).success).toBe(false);
    let deep: unknown = {};
    for (let i = 0; i < 20; i++) deep = { items: deep };
    expect(webhookBodySchema.safeParse(deep).success).toBe(false);
    expect(
      webhookBodySchema.safeParse({ enum: Array.from({ length: 513 }, (_, i) => i) }).success
    ).toBe(false);
  });

  it('provides an accepted example', () => {
    expect(webhookBodySchema.safeParse(WEBHOOK_BODY_SCHEMA_EXAMPLE).success).toBe(true);
    expect(
      validateWebhookBody(WEBHOOK_BODY_SCHEMA_EXAMPLE, '{"url":"https://example.com/webhook"}')
        .valid
    ).toBe(true);
  });
});

describe('JSON own-property semantics', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'preserves and validates %s at root and nested positions',
    key => {
      for (const nested of [false, true]) {
        const objectSchema = {
          type: 'object',
          properties: { [key]: { type: 'string' } },
          additionalProperties: false,
        };
        const wrapSchema = (schema: object) =>
          nested
            ? {
                type: 'object',
                properties: { outer: schema },
                required: ['outer'],
                additionalProperties: false,
              }
            : schema;
        const body = (value: object) => JSON.stringify(nested ? { outer: value } : value);
        const optional = webhookBodySchema.parse(wrapSchema(objectSchema));
        const stored = nested
          ? (optional.properties as Record<string, { properties: object }>).outer.properties
          : optional.properties;
        expect(Object.hasOwn(stored as object, key)).toBe(true);
        expect(validateWebhookBody(optional, body({}))).toEqual({ valid: true });
        expect(validateWebhookBody(optional, body({ [key]: 'value' }))).toEqual({ valid: true });
        expect(validateWebhookBody(optional, body({ [key]: 42 })).valid).toBe(false);
        const required = webhookBodySchema.parse(wrapSchema({ ...objectSchema, required: [key] }));
        expect(validateWebhookBody(required, body({})).valid).toBe(false);
        expect(validateWebhookBody(required, body({ [key]: 'value' }))).toEqual({ valid: true });
        expect(validateWebhookBody(required, body({ [key]: 42 })).valid).toBe(false);
        const noProperties = webhookBodySchema.parse(
          wrapSchema({ type: 'object', properties: {}, additionalProperties: false })
        );
        expect(validateWebhookBody(noProperties, body({ [key]: 'value' })).valid).toBe(false);
      }
    }
  );

  it('ignores inherited schema definitions while preserving own special-name definitions', () => {
    const properties = Object.create({
      constructor: { type: 'string' },
      toString: { type: 'string' },
    });
    Object.defineProperty(properties, '__proto__', { enumerable: true, value: { type: 'number' } });
    const schema = webhookBodySchema.parse({
      type: 'object',
      properties,
      additionalProperties: false,
    });
    expect(Object.keys(schema.properties as object)).toEqual(['__proto__']);
    expect(validateWebhookBody(schema, '{}')).toEqual({ valid: true });
    expect(validateWebhookBody(schema, '{"constructor":"extra"}').valid).toBe(false);
    expect(validateWebhookBody(schema, '{"toString":"extra"}').valid).toBe(false);
    expect(validateWebhookBody(schema, '{"__proto__":2}')).toEqual({ valid: true });
    expect(validateWebhookBody(schema, '{"__proto__":"wrong"}').valid).toBe(false);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'retains JSON equality semantics for const, enum and uniqueItems containing %s',
    key => {
      const value = { [key]: { nested: ['value', null, true] } };
      const differentKey = { other: { nested: ['value', null, true] } };
      const constant = webhookBodySchema.parse({ const: value });
      const enumeration = webhookBodySchema.parse({ enum: [value] });
      for (const schema of [constant, enumeration]) {
        expect(validateWebhookBody(schema, JSON.stringify(value))).toEqual({ valid: true });
        expect(validateWebhookBody(schema, JSON.stringify(differentKey)).valid).toBe(false);
        expect(
          validateWebhookBody(
            schema,
            JSON.stringify({ [key]: { nested: ['changed', null, true] } })
          ).valid
        ).toBe(false);
      }
      const unique = webhookBodySchema.parse({ type: 'array', uniqueItems: true });
      expect(validateWebhookBody(unique, JSON.stringify([value, value])).valid).toBe(false);
      expect(validateWebhookBody(unique, JSON.stringify([value, differentKey]))).toEqual({
        valid: true,
      });
    }
  );

  it('validates own __proto__ property schemas instead of stripping unsupported keywords', () => {
    expect(
      webhookBodySchema.safeParse({ properties: { ['__proto__']: { format: 'email' } } }).success
    ).toBe(false);
  });
});

describe('fixed URL validation with standard JSON Schema', () => {
  it('accepts the exact starter URL and rejects origin, path and trailing-data changes', () => {
    const schema = webhookBodySchema.parse(WEBHOOK_BODY_SCHEMA_EXAMPLE);
    expect(validateWebhookBody(schema, '{"url":"https://example.com/webhook"}')).toEqual({
      valid: true,
    });
    for (const url of [
      'http://example.com/webhook',
      'https://other.example/webhook',
      'https://example.com/other',
      'https://example.com/webhook/',
      'https://example.com/webhook?extra=true',
      'https://example.com/webhook#extra',
      'https://example.com/webhook trailing',
    ]) {
      expect(validateWebhookBody(schema, JSON.stringify({ url })).valid).toBe(false);
    }
  });

  it('accepts a short enum list and rejects a URL outside the list', () => {
    const urls = ['https://example.com/webhook', 'https://example.com/other'];
    const schema = webhookBodySchema.parse({
      type: 'object',
      properties: { url: { type: 'string', enum: urls } },
      required: ['url'],
      additionalProperties: false,
    });
    for (const url of urls)
      expect(validateWebhookBody(schema, JSON.stringify({ url }))).toEqual({ valid: true });
    expect(validateWebhookBody(schema, '{"url":"https://example.com/unknown"}').valid).toBe(false);
  });
});

describe('standard JSON Schema pattern matching', () => {
  it.each([
    ['^issue\\.(opened|closed)$', 'issue.opened', 'issue.changed'],
    ['issue\\.(opened|closed)', 'prefix issue.closed suffix', 'prefix issue.changed suffix'],
    [
      '^https://example\\.com/issues/[0-9]+$',
      'https://example.com/issues/123',
      'https://example.com/issues/abc',
    ],
  ])('uses ordinary pattern semantics for %s', (pattern, accepted, rejected) => {
    const schema = webhookBodySchema.parse({ type: 'string', pattern });
    expect(validateWebhookBody(schema, JSON.stringify(accepted))).toEqual({ valid: true });
    expect(validateWebhookBody(schema, JSON.stringify(rejected)).valid).toBe(false);
  });

  it('applies patterns inside nested objects, arrays and compositions', () => {
    const schema = webhookBodySchema.parse({
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: { allOf: [{ type: 'string' }, { pattern: 'issue\\.(opened|closed)' }] },
        },
      },
      required: ['events'],
      additionalProperties: false,
    });
    expect(
      validateWebhookBody(schema, '{"events":["issue.opened","prefix issue.closed suffix"]}')
    ).toEqual({ valid: true });
    expect(validateWebhookBody(schema, '{"events":["issue.opened","issue.changed"]}').valid).toBe(
      false
    );
  });
});
