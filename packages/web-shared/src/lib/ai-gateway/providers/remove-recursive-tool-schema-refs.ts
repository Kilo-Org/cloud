import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { throttledLog } from '@kilocode/web-shared/lib/ai-gateway/providers/throttled-log';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const logChangedTools = throttledLog(details =>
  warnExceptInTest('[removeRecursiveToolSchemaRefs] removed recursive tool schema refs', details)
);

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
 * Non-recursive refs are kept. Mutates the schema in place and returns the
 * number of removed refs.
 */
export function removeRecursiveJsonSchemaRefs(schema: unknown): number {
  if (!isRecord(schema)) {
    return 0;
  }
  let removedRefs = 0;
  const root = schema;
  const expanding = new Set<object>();
  const expanded = new Set<object>();

  const visit = (node: unknown) => {
    if (!isRecord(node) || expanded.has(node) || expanding.has(node)) {
      return;
    }
    expanding.add(node);

    if (typeof node.$ref === 'string') {
      const target = resolveLocalRef(root, node.$ref);
      if (isRecord(target) && expanding.has(target)) {
        delete node.$ref;
        removedRefs++;
        if (node.type === undefined && target.type !== undefined) {
          node.type = target.type;
        }
      } else {
        visit(target);
      }
    }

    forEachChildSchema(node, visit);

    expanding.delete(node);
    expanded.add(node);
  };

  visit(root);
  return removedRefs;
}

export function removeRecursiveToolSchemaRefs(request: GatewayRequest): void {
  const changedTools: { name: string; removedRefs: number }[] = [];
  const update = (name: string, schema: unknown) => {
    const removedRefs = removeRecursiveJsonSchemaRefs(schema);
    if (removedRefs > 0) {
      changedTools.push({ name, removedRefs });
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

  if (changedTools.length > 0) {
    logChangedTools({ model: request.body.model, requestKind: request.kind, tools: changedTools });
  }
}
