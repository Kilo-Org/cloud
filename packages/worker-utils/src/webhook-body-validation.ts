import { Validator, type Schema } from '@cfworker/json-schema';
import { z } from 'zod';

const MAX_SCHEMA_BYTES = 32_768;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 512;
const instanceType = z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue = z.custom<JsonValue>(value => {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (typeof item !== 'object') return false;
    const children: unknown[] = Object.values(item);
    pending.push(...children);
  }
  return true;
}, 'Must contain JSON values');
const count = z.number().int().nonnegative();
const pattern = z
  .string()
  .max(1024)
  .refine(value => {
    try {
      new RegExp(value, 'u');
      return true;
    } catch {
      return false;
    }
  }, 'Pattern must be a valid regular expression');

// Keep RPC contracts shallow. The recursive parser validates every nested keyword.
export type WebhookBodySchema = Record<string, unknown>;
type SchemaNode = {
  type?: z.infer<typeof instanceType> | z.infer<typeof instanceType>[];
  title?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  enum?: JsonValue[];
  const?: JsonValue;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  not?: SchemaNode;
};

const recursiveSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.strictObject({
    type: z.union([instanceType, z.array(instanceType).min(1).max(7)]).optional(),
    title: z.string().max(256).optional(),
    description: z.string().max(2048).optional(),
    properties: ownPropertySchemas.optional(),
    required: z.array(z.string()).max(256).optional(),
    additionalProperties: z.union([z.boolean(), recursiveSchema]).optional(),
    items: recursiveSchema.optional(),
    enum: z.array(jsonValue).min(1).max(256).optional(),
    const: jsonValue.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    multipleOf: z.number().positive().optional(),
    minLength: count.optional(),
    maxLength: count.optional(),
    pattern: pattern.optional(),
    minItems: count.optional(),
    maxItems: count.optional(),
    uniqueItems: z.boolean().optional(),
    minProperties: count.optional(),
    maxProperties: count.optional(),
    allOf: z.array(recursiveSchema).min(1).max(32).optional(),
    anyOf: z.array(recursiveSchema).min(1).max(32).optional(),
    oneOf: z.array(recursiveSchema).min(1).max(32).optional(),
    not: recursiveSchema.optional(),
  })
);

// z.record intentionally strips __proto__. Schema property names must retain every JSON key.
const ownPropertySchemas: z.ZodType<Record<string, SchemaNode>> = z
  .unknown()
  .transform((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({ code: 'custom', message: 'Properties must be an object' });
      return z.NEVER;
    }
    const result: Record<string, SchemaNode> = {};
    let valid = true;
    for (const [key, child] of Object.entries(value)) {
      const parsed = recursiveSchema.safeParse(child);
      if (parsed.success) {
        Object.defineProperty(result, key, {
          value: parsed.data,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        valid = false;
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
        }
      }
    }
    return valid ? result : z.NEVER;
  });

// The validator uses `in` and property reads. Null prototypes give JSON own-key semantics.
// Iterate so a deeply nested payload cannot overflow this normalization step's call stack.
function normalizeJsonObjects(value: Record<string, unknown>): Record<string, unknown>;
function normalizeJsonObjects(value: unknown): unknown;
function normalizeJsonObjects(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const copyObject = (source: object): object => {
    if (Array.isArray(source)) return [];
    const copy = {};
    Object.setPrototypeOf(copy, null);
    return copy;
  };
  const root = copyObject(value);
  const pending = [{ source: value, target: root }];
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const entries: [string, unknown][] = Object.entries(item.source);
    for (const [key, child] of entries) {
      const copy: unknown = child !== null && typeof child === 'object' ? copyObject(child) : child;
      Object.defineProperty(item.target, key, {
        value: copy,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (
        child !== null &&
        typeof child === 'object' &&
        copy !== null &&
        typeof copy === 'object'
      ) {
        pending.push({ source: child, target: copy });
      }
    }
  }
  return root;
}

// Bound unknown input before recursive parsing, including enum and const values.
const boundedSchema = z.unknown().superRefine((value, ctx) => {
  let nodes = 0;
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    nodes++;
    if (nodes > MAX_SCHEMA_NODES || item.depth > MAX_SCHEMA_DEPTH) {
      ctx.addIssue({ code: 'custom', message: 'Schema exceeds the depth or node limit' });
      return;
    }
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) {
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).length > MAX_SCHEMA_BYTES
    ) {
      ctx.addIssue({ code: 'custom', message: 'Schema must be at most 32 KiB' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Schema must contain JSON values' });
  }
});

/** Supported JSON Schema subset. Unknown keywords and all references are rejected. */
export const webhookBodySchema: z.ZodType<WebhookBodySchema> = boundedSchema
  .transform(value => normalizeJsonObjects(value))
  .pipe(recursiveSchema);

export type WebhookBodyIssue = { path: string; message: string };
export function validateWebhookBody(
  schema: WebhookBodySchema,
  rawBody: string
): { valid: true } | { valid: false; issues: WebhookBodyIssue[] } {
  let body: unknown;
  try {
    body = normalizeJsonObjects(JSON.parse(rawBody));
  } catch {
    return { valid: false, issues: [{ path: '/', message: 'Body must be valid JSON' }] };
  }
  // Short circuit bounds diagnostics and never include payload values in errors.
  const result = new Validator(
    normalizeJsonObjects(schema) satisfies Schema,
    '2020-12',
    true
  ).validate(body);
  return result.valid
    ? { valid: true }
    : {
        valid: false,
        issues: result.errors.slice(0, 10).map(issue => ({
          path: issue.instanceLocation.slice(0, 256) || '/',
          message: `Body does not satisfy ${issue.keyword.slice(0, 64)}`,
        })),
      };
}

export const WEBHOOK_BODY_SCHEMA_EXAMPLE: WebhookBodySchema = {
  type: 'object',
  properties: { url: { type: 'string', const: 'https://example.com/webhook' } },
  required: ['url'],
  additionalProperties: false,
};
