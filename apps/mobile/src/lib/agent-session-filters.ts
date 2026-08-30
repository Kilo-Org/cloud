import { z } from 'zod';

/**
 * Pure contract for the persisted session filter set. Intentionally free of
 * any Expo / SecureStore imports so it can be unit-tested in node and re-used
 * by tests/mocks without touching the native bridge.
 *
 * Both session-list pages persist this shape, under their own storage key.
 */
export type AgentSessionFilters = {
  platformFilter: string[];
  projectFilter: string[];
};

export function createDefaultAgentSessionFilters(): AgentSessionFilters {
  return {
    platformFilter: [],
    projectFilter: [],
  };
}

/** Zod's validation `.catch()` fallback, not a Promise catch. */
function tolerant<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod schema fallback, not a Promise
  return schema.catch(fallback);
}

const stringItemSchema = z.string();

function isStringItem(item: unknown): item is string {
  return stringItemSchema.safeParse(item).success;
}

/** Keeps only string entries; a non-array or wholly-bad value collapses to `[]`. */
const tolerantStringArraySchema = tolerant(z.array(z.unknown()), []).transform(items =>
  items.filter((item): item is string => isStringItem(item))
);

const storedAgentSessionFiltersSchema = z.object({
  platformFilter: tolerantStringArraySchema,
  projectFilter: tolerantStringArraySchema,
});

/**
 * Parse the raw SecureStore JSON for a session filter record. Returns `null`
 * only when the JSON itself is malformed or not an object — in every other
 * case the function tolerantly recovers so a partially bad record (e.g. a
 * non-array platformFilter, or a legacy record still carrying `sortBy`) still
 * produces a usable filter object.
 */
export function parseStoredAgentSessionFilters(raw: string | null): AgentSessionFilters | null {
  if (!raw) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = storedAgentSessionFiltersSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return {
    platformFilter: result.data.platformFilter,
    projectFilter: result.data.projectFilter,
  };
}

/** How many narrowing filters are applied — drives the header badge count. */
export function countActiveSessionFilters(filters: AgentSessionFilters): number {
  return filters.platformFilter.length + filters.projectFilter.length;
}
