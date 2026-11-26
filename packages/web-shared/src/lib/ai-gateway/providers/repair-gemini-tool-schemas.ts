import { withinSchemaBudget } from '@kilocode/web-shared/lib/ai-gateway/providers/client-schema-budget';
import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { forEachToolSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/tool-schema-walk';
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
const TYPE_KEYWORDS = {
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
} satisfies Record<string, ReadonlySet<string>>;

type JsonType = keyof typeof TYPE_KEYWORDS;

const TYPED_KEYWORDS = new Set(Object.values(TYPE_KEYWORDS).flatMap(keywords => [...keywords]));

// Restricting types to the seven JSON types bounds a repaired node to seven branches.
function isJsonType(type: unknown): type is JsonType {
  return typeof type === 'string' && Object.hasOwn(TYPE_KEYWORDS, type);
}

function matchesType(type: JsonType, value: unknown): boolean {
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
  }
  // Every JSON type is handled above; a new type fails to compile here.
  return type satisfies never;
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
  type: JsonType
): boolean {
  for (const key of keys) {
    if (key in target) continue;
    const value = source[key];
    if (TYPED_KEYWORDS.has(key) && !TYPE_KEYWORDS[type].has(key)) continue;
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
  if (!Array.isArray(types) || !types.every(isJsonType)) return false;
  if (hasCombinator(node)) return false;
  const values: unknown[] = [
    ...(Array.isArray(node.enum) ? (node.enum as unknown[]) : []),
    ...('const' in node ? [node.const] : []),
  ];
  if (values.length === 0) return false;
  const keys = Object.keys(node).filter(key => key !== 'type' && key !== 'description');
  if (!movesWithoutCopies(node, keys)) return false;
  const branchTypes = new Set<JsonType>(types);
  const branches: Record<string, unknown>[] = [];
  for (const type of branchTypes) {
    if (type === 'null') continue;
    // Every integer is a number, so the number branch already covers it.
    if (type === 'integer' && branchTypes.has('number')) continue;
    const branch: Record<string, unknown> = { type };
    if (copyKeywordsForType(branch, node, keys, type)) branches.push(branch);
  }
  if (branches.length < 2) return false;
  if (branchTypes.has('null') && values.includes(null)) branches.push({ type: 'null' });
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
 * Only an `anyOf` whose branches each have a distinct JSON `type` is rewritten,
 * so that no subschema is copied into several branches. A node is also left
 * alone when a branch sets one of the moved keys to another value, or when no
 * branch could match, since merging those would change what the schema accepts.
 */
function distributeAnyOfSiblings(node: Record<string, unknown>): boolean {
  if (!Array.isArray(node.anyOf)) return false;
  const keys = Object.keys(node).filter(key => !ANY_OF_KEYS.has(key));
  if (keys.length === 0) return false;
  const anyOf = node.anyOf as unknown[];
  if (anyOf.length > Object.keys(TYPE_KEYWORDS).length) return false;
  const types: (JsonType | undefined)[] = anyOf.map(branch =>
    isRecord(branch) && isJsonType(branch.type) ? branch.type : undefined
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
    const branchType = branch.type;
    if (!isJsonType(branchType)) continue;
    let type = branchType;
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

// The JSON characters that copies made by `spreadTypedAnyOf` may add to one schema.
const SPREAD_COPY_BUDGET = 1_000_000;

/**
 * Moves the keys beside the `anyOf` of a typed node into every branch:
 * `A and anyOf(B, C)` equals `anyOf(A and B, A and C)`. Gemini 3 behind Vercel
 * AI Gateway rejects both the keys beside the `anyOf` and a branch without a
 * type, so `{ type: "object", properties, anyOf: [{ required: ["a"] }, ...] }`
 * and the `{ type: "array", anyOf: [...] }` that Kilo CLI versions before
 * Kilo-Org/kilocode#16540 send for MCP tools both fail there.
 *
 * Unlike `distributeAnyOfSiblings`, this copies subschemas such as `properties`
 * into every branch. `budget` holds the JSON characters all copies may still
 * add, which bounds the size of a repaired schema. A node is left alone when a
 * branch sets a moved key to another value or sets `nullable`, since merging
 * those would change what it accepts. A branch with its own `anyOf` is spread
 * the same way, because the moved keys would otherwise sit beside it.
 */
function spreadTypedAnyOf(node: Record<string, unknown>, budget: { remaining: number }): boolean {
  if (!isJsonType(node.type) || !Array.isArray(node.anyOf)) return false;
  const anyOf = node.anyOf as unknown[];
  if (anyOf.length === 0 || !anyOf.every(isRecord)) return false;
  const keys = Object.keys(node).filter(key => !ANY_OF_KEYS.has(key));
  const conflicts = anyOf.some(
    branch =>
      'nullable' in branch ||
      keys.some(key => key in branch && JSON.stringify(branch[key]) !== JSON.stringify(node[key]))
  );
  if (conflicts) return false;

  const moved = Object.fromEntries(keys.map(key => [key, node[key]]));
  // Every branch costs at least one character, so an empty `moved` stays bounded.
  const cost = (JSON.stringify(moved).length + 1) * anyOf.length;
  if (cost > budget.remaining) return false;
  budget.remaining -= cost;

  const branches = anyOf.map(branch => {
    const merged: Record<string, unknown> = { ...structuredClone(moved), ...branch };
    spreadTypedAnyOf(merged, budget);
    return merged;
  });
  const nullable = node.nullable === true ? { nullable: true } : {};
  replaceContents(node, { anyOf: branches, ...nullable, ...descriptionOf(node) });
  return true;
}

/**
 * Gives an array schema without `items` the empty schema, which accepts any
 * item. Gemini behind Vercel AI Gateway rejects such a node with "items: missing
 * field", including a typed array beside an `anyOf` or `oneOf`, which Kilo CLI
 * versions before Kilo-Org/kilocode#16540 send for MCP tools.
 */
function addMissingArrayItems(node: Record<string, unknown>): boolean {
  if ('items' in node) return false;
  const type = node.type;
  if (type !== 'array' && !(Array.isArray(type) && type.includes('array'))) return false;
  node.items = {};
  return true;
}

/**
 * Rewrites the schema nodes below the root that Gemini rejects. The root of a
 * tool schema stays an object schema, and a schema over the node or depth
 * budget is left untouched. Mutates the schema in place and returns the number
 * of nodes rewritten.
 */
export function repairGeminiJsonSchema(schema: unknown): number {
  if (!isRecord(schema) || !withinSchemaBudget(schema)) return 0;
  let repaired = 0;
  const budget = { remaining: SPREAD_COPY_BUDGET };
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    forEachChildSchema(node, visit);
    if (spreadTypedAnyOf(node, budget)) repaired++;
    if (lowerMixedTypeArray(node)) repaired++;
    if (distributeAnyOfSiblings(node)) repaired++;
  };
  forEachChildSchema(schema, visit);
  // A separate pass, so that `items` added to a branch does not count as a
  // conflict when distributing, and the array branches created above get it too.
  const addItems = (node: unknown) => {
    if (!isRecord(node)) return;
    forEachChildSchema(node, addItems);
    if (addMissingArrayItems(node)) repaired++;
  };
  forEachChildSchema(schema, addItems);
  return repaired;
}

export function repairGeminiToolSchemas(request: GatewayRequest): void {
  const repairedTools: { name: string; nodes: number }[] = [];
  const repair = (name: string, schema: unknown) => {
    const nodes = repairGeminiJsonSchema(schema);
    if (nodes > 0) repairedTools.push({ name, nodes });
  };

  forEachToolSchema(request, repair);

  if (repairedTools.length > 0) {
    warnExceptInTest('[repairGeminiToolSchemas] repaired tool schemas Gemini rejects', {
      model: request.body.model,
      requestKind: request.kind,
      tools: repairedTools,
    });
  }
}
