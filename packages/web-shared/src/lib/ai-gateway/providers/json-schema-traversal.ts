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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Calls `visit` with every value in a schema position directly below `schema`.
 * Values may be booleans or other non-schema values, which `visit` must ignore.
 */
export function forEachChildSchema(
  schema: Record<string, unknown>,
  visit: (child: unknown) => void
): void {
  for (const [key, value] of Object.entries(schema)) {
    if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
      if (isRecord(value)) {
        for (const child of Object.values(value)) visit(child);
      }
    } else if (!DATA_KEYWORDS.has(key)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        visit(value);
      }
    }
  }
}
