import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

// Gemini allows only these keys beside `anyOf`.
const ANY_OF_KEYS = new Set(['anyOf', 'nullable', 'description']);

const NUMERIC_KEYWORDS = [
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
];

// Keywords that constrain a single JSON type. A branch of that type gets only its own.
const TYPE_KEYWORDS: Record<string, Set<string>> = {
  string: new Set([
    'format',
    'pattern',
    'minLength',
    'maxLength',
    'contentEncoding',
    'contentMediaType',
  ]),
  number: new Set(NUMERIC_KEYWORDS),
  integer: new Set(NUMERIC_KEYWORDS),
  boolean: new Set(),
  null: new Set(),
  array: new Set([
    'items',
    'prefixItems',
    'minItems',
    'maxItems',
    'uniqueItems',
    'contains',
    'minContains',
    'maxContains',
  ]),
  object: new Set([
    'properties',
    'required',
    'additionalProperties',
    'patternProperties',
    'propertyNames',
    'minProperties',
    'maxProperties',
    'dependentRequired',
    'dependentSchemas',
  ]),
};

const TYPED_KEYWORDS = new Set(Object.values(TYPE_KEYWORDS).flatMap(keywords => [...keywords]));

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true;
  }
}

/**
 * Copies `keys` of `source` into `target` where they apply to `type`. Enum and
 * example values are narrowed to `type`, and a default of another type is
 * dropped. Returns false when no value of `type` satisfies the enum or const.
 */
function copyKeywordsForType(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
  type: string
): boolean {
  for (const key of keys) {
    if (key in target) continue;
    const value = source[key];
    if (TYPED_KEYWORDS.has(key) && !TYPE_KEYWORDS[type]?.has(key)) continue;
    if ((key === 'enum' || key === 'examples') && Array.isArray(value)) {
      const values = value.filter(item => matchesType(type, item));
      if (key === 'enum' && values.length === 0) return false;
      target[key] = values;
    } else if (key === 'const' && !matchesType(type, value)) {
      return false;
    } else if (key !== 'default' || matchesType(type, value)) {
      target[key] = value;
    }
  }
  return true;
}

function replaceContents(node: Record<string, unknown>, contents: Record<string, unknown>) {
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, contents);
}

function descriptionOf(node: Record<string, unknown>) {
  return 'description' in node ? { description: node.description } : {};
}

function hasCombinator(node: Record<string, unknown>) {
  return 'anyOf' in node || 'oneOf' in node || 'allOf' in node;
}

const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);

/**
 * Whether moving `keys` of `node` into branches of distinct types copies no
 * subschema into more than one branch. Type-specific keywords go to their own
 * type's branch and data values are narrowed per type, so only scalars such as
 * `title` are repeated, and a repaired schema stays about the size of its input.
 */
function movesWithoutCopies(node: Record<string, unknown>, keys: string[]) {
  return keys.every(
    key =>
      TYPED_KEYWORDS.has(key) ||
      DATA_KEYWORDS.has(key) ||
      typeof node[key] !== 'object' ||
      node[key] === null
  );
}

/**
 * A type array is accepted unless its enum or const values span more than one
 * non-null type, which Gemini rejects. Such a node becomes an `anyOf` with one
 * branch per type that has values, plus a null branch when null is a value.
 */
function lowerMixedTypeArray(node: Record<string, unknown>): boolean {
  const types = node.type;
  if (!Array.isArray(types) || !types.every(type => typeof type === 'string')) return false;
  if (hasCombinator(node)) return false;
  const values: unknown[] = [
    ...(Array.isArray(node.enum) ? (node.enum as unknown[]) : []),
    ...('const' in node ? [node.const] : []),
  ];
  if (values.length === 0) return false;
  const keys = Object.keys(node).filter(key => key !== 'type' && key !== 'description');
  if (!movesWithoutCopies(node, keys)) return false;
  const branches: Record<string, unknown>[] = [];
  for (const type of new Set(types)) {
    if (type === 'null') continue;
    // Every integer is a number, so the number branch already covers it.
    if (type === 'integer' && types.includes('number')) continue;
    const branch: Record<string, unknown> = { type };
    if (copyKeywordsForType(branch, node, keys, type)) branches.push(branch);
  }
  if (branches.length < 2) return false;
  if (types.includes('null') && values.includes(null)) branches.push({ type: 'null' });
  replaceContents(node, { anyOf: branches, ...descriptionOf(node) });
  return true;
}

/**
 * Moves the keys beside an `anyOf`, which Gemini rejects, into its branches.
 *
 * Kilo CLI versions before Kilo-Org/kilocode#16346 send such nodes for JSON
 * Schema type arrays: `{ type: ["string", "null"], enum: ["a", null] }` arrives
 * as `{ anyOf: [{ type: "string" }], nullable: true, enum: ["a", "null"] }`.
 * The CLI stringified every enum value, so with `nullable` the string "null"
 * was a JSON null, a numeric branch whose enum has only strings is the CLI's
 * integer-to-string enum conversion, and "true" and "false" in a boolean
 * branch were booleans. Nullability becomes a null branch, which every Gemini
 * upstream accepts.
 *
 * Only an `anyOf` whose branches each have a distinct `type` is rewritten, so
 * that no subschema is copied into several branches. A node is also left
 * alone when a branch sets one of the moved keys to another value, or when no
 * branch could match, since merging those would change what the schema accepts.
 */
function distributeAnyOfSiblings(node: Record<string, unknown>): boolean {
  if (!Array.isArray(node.anyOf)) return false;
  const keys = Object.keys(node).filter(key => !ANY_OF_KEYS.has(key));
  if (keys.length === 0) return false;
  const anyOf = node.anyOf as unknown[];
  const types = anyOf.map(branch =>
    isRecord(branch) && typeof branch.type === 'string' ? branch.type : undefined
  );
  if (types.some(type => type === undefined) || new Set(types).size !== types.length) {
    return false;
  }
  if (!movesWithoutCopies(node, keys)) return false;
  const conflicts = (anyOf as Record<string, unknown>[]).some(branch =>
    keys.some(key => key in branch && JSON.stringify(branch[key]) !== JSON.stringify(node[key]))
  );
  if (conflicts) return false;

  const nullable = node.nullable === true;
  const source = { ...node };
  if (nullable && Array.isArray(source.enum)) {
    source.enum = source.enum.filter(value => value !== 'null');
  }
  const enumValues = Array.isArray(source.enum) ? (source.enum as unknown[]) : undefined;
  const stringEnum = enumValues?.every(value => typeof value === 'string') ?? false;
  const booleanSource =
    stringEnum && enumValues?.every(value => value === 'true' || value === 'false')
      ? { ...source, enum: enumValues.map(value => value === 'true') }
      : source;

  const branches: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const branch of anyOf as Record<string, unknown>[]) {
    let type = branch.type as string;
    const out: Record<string, unknown> = { ...branch };
    if (stringEnum && (type === 'integer' || type === 'number')) {
      type = 'string';
      out.type = type;
      if (types.includes('string') || seen.has('string')) {
        // The string branch gets the same enum, so a bare converted branch would repeat it.
        if (Object.keys(branch).length > 1) return false;
        continue;
      }
    }
    if (!copyKeywordsForType(out, type === 'boolean' ? booleanSource : source, keys, type)) {
      continue;
    }
    seen.add(type);
    branches.push(out);
  }

  const onlyNull = nullable && enumValues?.length === 0;
  if (branches.length === 0 && !onlyNull) return false;
  if (nullable && !seen.has('null')) branches.push({ type: 'null' });
  replaceContents(node, { anyOf: branches, ...descriptionOf(node) });
  return true;
}

// Bounds the walk over a client-supplied schema, like sanitize-json-ref-tool-results.ts.
const SCHEMA_NODE_BUDGET = 100_000;
const SCHEMA_MAX_DEPTH = 64;

function withinBudget(schema: unknown): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: schema, depth: 0 }];
  let visited = 0;
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (!isRecord(frame.node)) continue;
    if (++visited > SCHEMA_NODE_BUDGET || frame.depth > SCHEMA_MAX_DEPTH) return false;
    const depth = frame.depth + 1;
    forEachChildSchema(frame.node, child => pending.push({ node: child, depth }));
  }
  return true;
}

/**
 * Rewrites the schema nodes below the root that Gemini rejects. The root of a
 * tool schema stays an object schema, and a schema over the node or depth
 * budget is left untouched. Mutates the schema in place and returns the number
 * of nodes rewritten.
 */
export function repairGeminiJsonSchema(schema: unknown): number {
  if (!isRecord(schema) || !withinBudget(schema)) return 0;
  let repaired = 0;
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    forEachChildSchema(node, visit);
    if (lowerMixedTypeArray(node)) repaired++;
    if (distributeAnyOfSiblings(node)) repaired++;
  };
  forEachChildSchema(schema, visit);
  return repaired;
}

export function repairGeminiToolSchemas(request: GatewayRequest): void {
  const repairedTools: { name: string; nodes: number }[] = [];
  const repair = (name: string, schema: unknown) => {
    const nodes = repairGeminiJsonSchema(schema);
    if (nodes > 0) repairedTools.push({ name, nodes });
  };

  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') repair(tool.function.name, tool.function.parameters);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') repair(tool.name, tool.parameters);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) repair(tool.name, tool.input_schema);
      }
      break;
  }

  if (repairedTools.length > 0) {
    warnExceptInTest('[repairGeminiToolSchemas] repaired tool schemas Gemini rejects', {
      model: request.body.model,
      requestKind: request.kind,
      tools: repairedTools,
    });
  }
}
