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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

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

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  return {
    platformFilter: readStringArray(parsed.platformFilter),
    projectFilter: readStringArray(parsed.projectFilter),
    sortBy: parseAgentSessionSortBy(parsed.sortBy),
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
