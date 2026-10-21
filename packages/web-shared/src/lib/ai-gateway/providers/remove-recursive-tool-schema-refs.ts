import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { geminiFunctionDeclarations } from '@kilocode/web-shared/lib/ai-gateway/generate-content';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointerSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
  } catch {
    return undefined;
  }
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') {
    return root;
  }
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = decodePointerSegment(rawSegment);
    if (segment === undefined) {
      return undefined;
    }
    if (Array.isArray(node)) {
      node = node[Number(segment)];
    } else if (isRecord(node)) {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Replaces every local `$ref` that points back into the schema currently being
 * expanded with a permissive schema, so the result is no longer recursive.
 * Non-recursive refs are kept. Mutates the schema in place.
 */
export function removeRecursiveJsonSchemaRefs(schema: unknown): void {
  if (!isRecord(schema)) {
    return;
  }
  const root = schema;
  const expanding = new Set<object>();
  const expanded = new Set<object>();

  const visit = (node: unknown, isSubschemaMap = false) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node) || expanded.has(node) || expanding.has(node)) {
      return;
    }
    expanding.add(node);

    if (!isSubschemaMap && typeof node.$ref === 'string') {
      const target = resolveLocalRef(root, node.$ref);
      if (isRecord(target) && expanding.has(target)) {
        delete node.$ref;
        if (node.type === undefined && target.type !== undefined) {
          node.type = target.type;
        }
      } else {
        visit(target);
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

    expanding.delete(node);
    expanded.add(node);
  };

  visit(root);
}

export function removeRecursiveToolSchemaRefs(request: GatewayRequest): void {
  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') removeRecursiveJsonSchemaRefs(tool.function.parameters);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') removeRecursiveJsonSchemaRefs(tool.parameters);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) removeRecursiveJsonSchemaRefs(tool.input_schema);
      }
      break;
    case 'generate_content':
      for (const declaration of geminiFunctionDeclarations(request.body)) {
        removeRecursiveJsonSchemaRefs(declaration.parametersJsonSchema ?? declaration.parameters);
      }
      break;
  }
}
