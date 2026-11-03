import { Validator, type Schema } from '@cfworker/json-schema';
import { z } from 'zod';
import { patternSafetyIssue } from './pattern-safety';

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

function compilesAsRegExp(value: string): boolean {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

// Write paths only accept a pattern that is inside the documented subset.
const pattern = z
  .string()
  .max(1024)
  .superRefine((value, ctx) => {
    if (!compilesAsRegExp(value)) {
      ctx.addIssue({ code: 'custom', message: 'Pattern must be a valid regular expression' });
      return;
    }
    const issue = patternSafetyIssue(value);
    if (issue !== null) ctx.addIssue({ code: 'custom', message: issue });
  });

// Schemas stored before a policy change must still load, so reads only require a compilable form.
const storedPattern = z
  .string()
  .max(1024)
  .refine(compilesAsRegExp, 'Pattern must be a valid regular expression');

// Keep RPC contracts shallow. The recursive parser validates every nested keyword.
export type WebhookBodySchema = Record<string, unknown>;
type SchemaNode = {
  type?: z.infer<typeof instanceType> | z.infer<typeof instanceType>[] | undefined;
  title?: string | undefined;
  description?: string | undefined;
  properties?: Record<string, SchemaNode> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | SchemaNode | undefined;
  items?: SchemaNode | undefined;
  enum?: JsonValue[] | undefined;
  const?: JsonValue | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  exclusiveMinimum?: number | undefined;
  exclusiveMaximum?: number | undefined;
  multipleOf?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  minProperties?: number | undefined;
  maxProperties?: number | undefined;
  allOf?: SchemaNode[] | undefined;
  anyOf?: SchemaNode[] | undefined;
  oneOf?: SchemaNode[] | undefined;
  not?: SchemaNode | undefined;
};

function createSchemaParser(patternSchema: z.ZodType<string>): z.ZodType<SchemaNode> {
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
      pattern: patternSchema.optional(),
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

  return recursiveSchema;
}

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
  .pipe(createSchemaParser(pattern));

const storedSchemaParser: z.ZodType<WebhookBodySchema> = boundedSchema
  .transform(value => normalizeJsonObjects(value))
  .pipe(createSchemaParser(storedPattern));

/**
 * Parses a schema read back from storage. Schemas written before a pattern policy change stay
 * loadable; `validateWebhookBody` reports the patterns that policy no longer accepts.
 */
export function parseStoredWebhookBodySchema(value: unknown): WebhookBodySchema {
  return storedSchemaParser.parse(value);
}

const SUBSCHEMA_KEYWORDS = ['items', 'additionalProperties', 'not'] as const;
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function childSchemas(node: Record<string, unknown>): [string, Record<string, unknown>][] {
  const children: [string, Record<string, unknown>][] = [];
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    const child = node[keyword];
    if (isSchemaObject(child)) children.push([keyword, child]);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const list = node[keyword];
    if (!isUnknownArray(list)) continue;
    list.forEach((child, index) => {
      if (isSchemaObject(child)) children.push([`${keyword}/${index}`, child]);
    });
  }
  const properties = node['properties'];
  if (isSchemaObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isSchemaObject(child)) children.push([`properties/${name}`, child]);
    }
  }
  return children;
}

/** Schema locations of `pattern` keywords that the write path does not accept. */
export function unsupportedPatternPaths(schema: WebhookBodySchema): string[] {
  const paths: string[] = [];
  const walk = (node: Record<string, unknown>, pointer: string) => {
    const source = node['pattern'];
    if (typeof source === 'string' && patternSafetyIssue(source) !== null) {
      paths.push(`${pointer}/pattern`);
    }
    for (const [path, child] of childSchemas(node)) walk(child, `${pointer}/${path}`);
  };
  walk(schema, '');
  return paths;
}

export type WebhookBodyIssue = { path: string; message: string };
export type WebhookBodyValidation =
  | { valid: true; unsupportedPatterns?: string[] }
  | { valid: false; issues: WebhookBodyIssue[] };
export function validateWebhookBody(
  schema: WebhookBodySchema,
  rawBody: string
): WebhookBodyValidation {
  let body: unknown;
  try {
    body = normalizeJsonObjects(JSON.parse(rawBody));
  } catch {
    return { valid: false, issues: [{ path: '/', message: 'Body must be valid JSON' }] };
  }
  const normalized = normalizeJsonObjects(schema);
  // A schema stored before the current writer accepted it is not applied as a filter, because
  // dropping a keyword can change what its `not`, `anyOf` or `oneOf` parent means.
  const unsupportedPatterns = unsupportedPatternPaths(normalized);
  if (unsupportedPatterns.length > 0) return { valid: true, unsupportedPatterns };
  // Short circuit bounds diagnostics and never include payload values in errors.
  const result = new Validator(normalized satisfies Schema, '2020-12', true).validate(body);
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
