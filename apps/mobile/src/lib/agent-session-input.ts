import {
  type AgentSessionSortBy,
  DEFAULT_AGENT_SESSION_SORT,
  parseAgentSessionSortBy,
} from './agent-session-sort';

/**
 * Pure input-builder for the `cliSessionsV2.list` tRPC query. Lives in its
 * own module (no React, no react-query) so the test suite can exercise
 * sorting/filtering without pulling in the native bridge.
 *
 * Defaults `orderBy` to `updated_at` so callers that don't care about
 * sort (e.g. Home's session surface) keep the legacy behavior bit-for-bit.
 */
type AgentSessionListInput = {
  limit: number;
  orderBy: AgentSessionSortBy;
  includeChildren: boolean;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
};

const SESSIONS_PAGE_SIZE = 30;

function resolveSortBy(sortBy: AgentSessionSortBy | undefined): AgentSessionSortBy {
  return parseAgentSessionSortBy(sortBy ?? DEFAULT_AGENT_SESSION_SORT);
}

export function buildAgentSessionListInput(options: {
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
  sortBy?: AgentSessionSortBy;
}): AgentSessionListInput {
  const sortBy = resolveSortBy(options.sortBy);
  return {
    limit: SESSIONS_PAGE_SIZE,
    orderBy: sortBy,
    includeChildren: false,
    createdOnPlatform: options.createdOnPlatform,
    gitUrl: options.gitUrl,
    organizationId: options.organizationId,
  };
}

/**
 * Pure input-builder for the `cliSessionsV2.search` tRPC query. Same
 * rationale as `buildAgentSessionListInput` — kept in this module so the
 * test suite can cover sort fallback + passthrough without the native
 * stack.
 */
type AgentSessionSearchInput = {
  search_string: string;
  limit: number;
  orderBy: AgentSessionSortBy;
  includeChildren: boolean;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
};

export function buildAgentSessionSearchInput(options: {
  searchQuery: string;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
  sortBy?: AgentSessionSortBy;
}): AgentSessionSearchInput {
  const sortBy = resolveSortBy(options.sortBy);
  return {
    search_string: options.searchQuery,
    // Endpoint max; no offset paging — past 50 matches, refining the query is the answer.
    limit: 50,
    orderBy: sortBy,
    includeChildren: false,
    createdOnPlatform: options.createdOnPlatform,
    gitUrl: options.gitUrl,
    organizationId: options.organizationId,
  };
}
