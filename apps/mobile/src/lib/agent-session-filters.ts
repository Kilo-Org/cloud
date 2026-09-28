import { z } from 'zod';

import {
  normalisePlatformSelection,
  projectOptionKey,
} from '@/components/agents/session-list-helpers';

/**
 * Pure contract for the persisted session filter set. Intentionally free of
 * any Expo / SecureStore / native-bridge imports so it can be unit-tested in
 * node and re-used by tests/mocks without touching the native bridge. It
 * imports the visible-label project key (`projectOptionKey`) and the
 * platform-bucket collapse (`normalisePlatformSelection`) from the session-list
 * helpers so the badge counts each row the filter sheet renders once; that
 * module is native-free too, so the node test still runs.
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
  // One visible project option can carry several git-URL aliases (https vs ssh,
  // a `.git` suffix, host case) that render to one label, so the raw array
  // length over-counts the rows the sheet shows.
  const projectCount = new Set(filters.projectFilter.map(gitUrl => projectOptionKey(gitUrl))).size;
  // The sheet collapses a persisted platform variant into its bucket row
  // (`normalisePlatform` in the filter modal), so a legacy selection holding a
  // bucket and one of its variants (`cloud-agent` + `cloud-agent-web`) renders
  // one checked row and must count once. An unknown platform keeps its own row,
  // so it counts as itself.
  const platformCount = normalisePlatformSelection(filters.platformFilter).length;
  return platformCount + projectCount;
}
