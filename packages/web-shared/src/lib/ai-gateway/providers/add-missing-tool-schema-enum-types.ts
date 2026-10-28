import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

// Keywords whose values are instance data rather than subschemas.
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

// Keywords whose values map arbitrary names, such as property names, to subschemas.
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Moonshot accepts an enum of a single scalar type, optionally combined with
 * null, so other enums are left for the upstream to reject.
 */
function inferEnumType(values: unknown[]): string | string[] | undefined {
  const types = new Set(values.map(enumValueType));
  if (types.has('integer') && types.has('number')) {
    types.delete('integer');
  }
  const nullable = types.delete('null');
  const [type, ...rest] = types;
  if (type === undefined || rest.length > 0 || !SCALAR_TYPES.has(type)) {
    return undefined;
  }
  return nullable ? [type, 'null'] : type;
}

/**
 * Adds the `type` implied by the values of every `enum` that has no `type`.
 * Mutates the schema in place.
 */
export function addMissingJsonSchemaEnumTypes(schema: unknown): void {
  const visit = (node: unknown, isSubschemaMap = false) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (!isSubschemaMap && node.type === undefined && Array.isArray(node.enum)) {
      const type = inferEnumType(node.enum);
      if (type !== undefined) {
        node.type = type;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (isSubschemaMap) {
        visit(value);
      } else if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
        visit(value, true);
      } else if (!DATA_KEYWORDS.has(key)) {
        visit(value);
      }
    }
  };

  visit(schema);
}

export function addMissingToolSchemaEnumTypes(request: GatewayRequest): void {
  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') addMissingJsonSchemaEnumTypes(tool.function.parameters);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') addMissingJsonSchemaEnumTypes(tool.parameters);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) addMissingJsonSchemaEnumTypes(tool.input_schema);
      }
      break;
  }
}
