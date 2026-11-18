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
  type: string | undefined
): boolean {
  for (const key of keys) {
    if (key in target) continue;
    const value = source[key];
    if (type === undefined) {
      target[key] = value;
      continue;
    }
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
 * was a JSON null, and a numeric branch whose enum has only strings is the
 * CLI's integer-to-string enum conversion. Nullability becomes a null branch,
 * which every Gemini upstream accepts.
 *
 * A node is left alone when a branch sets one of the moved keys to another
 * value, or when no branch could match, since merging those would change what
 * the schema accepts.
 */
function distributeAnyOfSiblings(node: Record<string, unknown>): boolean {
  if (!Array.isArray(node.anyOf)) return false;
  const keys = Object.keys(node).filter(key => !ANY_OF_KEYS.has(key));
  if (keys.length === 0) return false;
  const anyOf = node.anyOf as unknown[];
  const conflicts = anyOf.some(
    branch =>
      isRecord(branch) &&
      keys.some(key => key in branch && JSON.stringify(branch[key]) !== JSON.stringify(node[key]))
  );
  if (conflicts) return false;

  const nullable = node.nullable === true;
  const source = { ...node };
  if (nullable && Array.isArray(source.enum)) {
    source.enum = source.enum.filter(value => value !== 'null');
  }
  const stringEnum =
    Array.isArray(source.enum) && source.enum.every(value => typeof value === 'string');

  const branches: unknown[] = [];
  for (const branch of anyOf) {
    if (!isRecord(branch) && branch !== true) {
      branches.push(branch);
      continue;
    }
    const out: Record<string, unknown> = isRecord(branch) ? { ...branch } : {};
    let type = typeof out.type === 'string' ? out.type : undefined;
    if (stringEnum && (type === 'integer' || type === 'number')) {
      type = 'string';
      out.type = type;
    }
    if (!copyKeywordsForType(out, source, keys, type)) continue;
    distributeAnyOfSiblings(out);
    branches.push(out);
  }

  const onlyNull = nullable && Array.isArray(source.enum) && source.enum.length === 0;
  if (branches.length === 0 && !onlyNull) return false;
  const unique = [...new Map(branches.map(branch => [JSON.stringify(branch), branch])).values()];
  if (nullable && !unique.some(branch => isRecord(branch) && branch.type === 'null')) {
    unique.push({ type: 'null' });
  }
  replaceContents(node, { anyOf: unique, ...descriptionOf(node) });
  return true;
}

/**
 * Rewrites the schema nodes below the root that Gemini rejects. The root of a
 * tool schema stays an object schema. Mutates the schema in place and returns
 * the number of nodes rewritten.
 */
export function repairGeminiJsonSchema(schema: unknown): number {
  let repaired = 0;
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    forEachChildSchema(node, visit);
    if (lowerMixedTypeArray(node)) repaired++;
    if (distributeAnyOfSiblings(node)) repaired++;
  };
  if (isRecord(schema)) forEachChildSchema(schema, visit);
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
