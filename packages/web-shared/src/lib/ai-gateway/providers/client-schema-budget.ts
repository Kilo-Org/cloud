import {
  forEachChildSchema,
  isRecord,
} from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import { CACHE_CONTROL_NODE_BUDGET } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';

/** The node budget shared by the walks over a client-supplied schema. */
export const CLIENT_SCHEMA_NODE_BUDGET = CACHE_CONTROL_NODE_BUDGET;

/** The depth bound shared by the walks over a client-supplied schema. */
export const CLIENT_SCHEMA_MAX_DEPTH = 64;

/**
 * Reports whether a client-supplied schema fits inside both walk bounds. Each
 * walk that uses these bounds leaves a schema over either of them unchanged
 * rather than partially rewriting it, so its cost stays proportional to the
 * size of the schema it was given.
 */
export function withinSchemaBudget(schema: unknown): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: schema, depth: 0 }];
  let visited = 0;
  let overBudget = false;
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (!isRecord(frame.node)) continue;
    if (++visited > CLIENT_SCHEMA_NODE_BUDGET || frame.depth > CLIENT_SCHEMA_MAX_DEPTH)
      return false;
    const depth = frame.depth + 1;
    forEachChildSchema(frame.node, child => {
      if (visited + pending.length >= CLIENT_SCHEMA_NODE_BUDGET) overBudget = true;
      else pending.push({ node: child, depth });
    });
    if (overBudget) return false;
  }
  return true;
}
