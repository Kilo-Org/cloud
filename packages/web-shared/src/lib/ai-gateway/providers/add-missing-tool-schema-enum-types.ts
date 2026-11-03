import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

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

type EnumTypeCounts = { typedEnums: number; untypedEnums: number };

/**
 * Adds the `type` implied by the values of every `enum` that has no `type`.
 * Mutates the schema in place and counts the enums that got a type and those
 * left untyped because Moonshot accepts no type for their values.
 */
export function addMissingJsonSchemaEnumTypes(schema: unknown): EnumTypeCounts {
  const counts: EnumTypeCounts = { typedEnums: 0, untypedEnums: 0 };
  const visit = (node: unknown) => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === undefined && Array.isArray(node.enum)) {
      const type = inferEnumType(node.enum);
      if (type === undefined) {
        counts.untypedEnums++;
      } else {
        node.type = type;
        counts.typedEnums++;
      }
    }
    forEachChildSchema(node, visit);
  };
  visit(schema);
  return counts;
}

export function addMissingToolSchemaEnumTypes(request: GatewayRequest): void {
  const affectedTools: ({ name: string } & EnumTypeCounts)[] = [];
  const update = (name: string, schema: unknown) => {
    const counts = addMissingJsonSchemaEnumTypes(schema);
    if (counts.typedEnums > 0 || counts.untypedEnums > 0) {
      affectedTools.push({ name, ...counts });
    }
  };

  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') update(tool.function.name, tool.function.parameters);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') update(tool.name, tool.parameters);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) update(tool.name, tool.input_schema);
      }
      break;
  }

  if (affectedTools.length > 0) {
    warnExceptInTest('[addMissingToolSchemaEnumTypes] found tool schema enums without a type', {
      model: request.body.model,
      requestKind: request.kind,
      tools: affectedTools,
    });
  }
}
