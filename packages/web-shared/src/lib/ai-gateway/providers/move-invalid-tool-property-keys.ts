import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

// Anthropic checks only the root `properties` of a tool schema against this pattern.
const VALID_PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function exactMatchPattern(key: string): string {
  return `^${key.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

/**
 * Moves root properties whose names Anthropic rejects into `patternProperties`
 * with a pattern that matches only that name, so the schema accepts the same
 * inputs and the model still emits the original names. `required` is left as
 * is, since Anthropic accepts any name there. Mutates the schema in place and
 * returns the moved names.
 */
export function moveInvalidPropertyKeys(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const invalid = Object.keys(properties).filter(key => !VALID_PROPERTY_KEY.test(key));
  if (invalid.length === 0) return [];

  const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties : {};
  const moved: string[] = [];
  for (const key of invalid) {
    const pattern = exactMatchPattern(key);
    if (pattern in patternProperties) continue;
    patternProperties[pattern] = properties[key];
    delete properties[key];
    moved.push(key);
  }
  if (moved.length > 0) schema.patternProperties = patternProperties;
  return moved;
}

/**
 * Anthropic rejects strict tools that use `patternProperties`, so a tool with
 * moved properties loses its `strict` flag rather than failing the request.
 */
export function moveInvalidToolPropertyKeys(request: GatewayRequest): void {
  const changedTools: { name: string; properties: string[]; strict: boolean }[] = [];
  const move = (name: string, schema: unknown, strict: boolean | null | undefined) => {
    const properties = moveInvalidPropertyKeys(schema);
    if (properties.length === 0) return false;
    changedTools.push({ name, properties, strict: strict === true });
    return true;
  };

  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const { name, parameters, strict } = tool.function;
        if (move(name, parameters, strict) && strict) delete tool.function.strict;
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        if (move(tool.name, tool.parameters, tool.strict) && tool.strict) tool.strict = false;
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if (!('input_schema' in tool)) continue;
        if (move(tool.name, tool.input_schema, tool.strict) && tool.strict) delete tool.strict;
      }
      break;
  }

  if (changedTools.length > 0) {
    warnExceptInTest(
      '[moveInvalidToolPropertyKeys] moved tool schema properties with names Anthropic rejects',
      {
        model: request.body.model,
        requestKind: request.kind,
        tools: changedTools,
      }
    );
  }
}
