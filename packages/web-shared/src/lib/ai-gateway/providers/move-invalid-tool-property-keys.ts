import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { clearRewrittenToolSchemaStrict } from '@kilocode/web-shared/lib/ai-gateway/providers/tool-schema-walk';

// Anthropic checks only the root `properties` of a tool schema against this pattern.
const VALID_PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

function exactMatchPattern(key: string): string {
  return `^${key.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

/**
 * Moves root properties whose names Anthropic rejects into `patternProperties`
 * with a pattern that matches only that name, so the schema accepts the same
 * inputs and the model still emits the original names. When that pattern
 * already exists, both schemas are combined with `allOf`. `required` is left
 * as is, since Anthropic accepts any name there. Mutates the schema in place
 * and returns the moved names.
 */
export function moveInvalidPropertyKeys(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const invalid = Object.keys(properties).filter(key => !VALID_PROPERTY_KEY.test(key));
  if (invalid.length === 0) return [];

  const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties : {};
  for (const key of invalid) {
    const pattern = exactMatchPattern(key);
    // The name already matched both schemas, and Anthropic accepts `allOf` below the root.
    patternProperties[pattern] =
      pattern in patternProperties
        ? { allOf: [patternProperties[pattern], properties[key]] }
        : properties[key];
    delete properties[key];
  }
  schema.patternProperties = patternProperties;
  return invalid;
}

/**
 * Anthropic rejects strict tools that use `patternProperties`, so a tool with
 * moved properties loses its `strict` flag rather than failing the request.
 * `clearRewrittenToolSchemaStrict` clears it the way each request kind
 * expresses the flag being off.
 */
export function moveInvalidToolPropertyKeys(request: GatewayRequest): void {
  const changedTools: { name: string; properties: string[]; strict: boolean }[] = [];
  const move = (name: string, schema: unknown, strict: boolean | null | undefined) => {
    const properties = moveInvalidPropertyKeys(schema);
    if (properties.length === 0) return false;
    changedTools.push({ name, properties, strict: strict === true });
    return true;
  };

  clearRewrittenToolSchemaStrict(request, move);

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
