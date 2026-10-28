import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

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
  if (!isRecord(schema)) {
    return;
  }
  if (schema.type === undefined && Array.isArray(schema.enum)) {
    const type = inferEnumType(schema.enum);
    if (type !== undefined) {
      schema.type = type;
    }
  }
  forEachChildSchema(schema, addMissingJsonSchemaEnumTypes);
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
