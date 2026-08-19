import { z } from 'zod';

import { type AgentSessionSortBy, parseAgentSessionSortBy } from './agent-session-sort';

/**
 * Pure contract for the persisted agent-session filter set. Intentionally
 * free of any Expo / SecureStore imports so it can be unit-tested in node
 * and re-used by tests/mocks without touching the native bridge.
 */
export type AgentSessionFilters = {
  platformFilter: string[];
  projectFilter: string[];
  sortBy: AgentSessionSortBy;
};

export function createDefaultAgentSessionFilters(): AgentSessionFilters {
  return {
    platformFilter: [],
    projectFilter: [],
    sortBy: parseAgentSessionSortBy(undefined),
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
  sortBy: z.unknown().optional(),
});

/**
 * Parse the raw SecureStore JSON for the agent-session filter record. Returns
 * `null` only when the JSON itself is malformed or not an object — in every
 * other case the function tolerantly recovers so a partially bad record
 * (e.g. an unknown sortBy or a non-array platformFilter) still produces a
 * usable filter object with the default where applicable.
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
    sortBy: parseAgentSessionSortBy(result.data.sortBy),
  };
}

/**
 * Reset the narrowing parts of the filter record (platform + project) while
 * leaving `sortBy` untouched — sort is a persistent preference, not a
 * transient filter, and "Clear filters" / "Clear search" must never
 * silently revert it to the default.
 */
export function clearAgentSessionNarrowingFilters(
  filters: AgentSessionFilters
): AgentSessionFilters {
  return {
    platformFilter: [],
    projectFilter: [],
    sortBy: filters.sortBy,
  };
}
