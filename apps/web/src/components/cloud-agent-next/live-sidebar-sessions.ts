import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';

/** The part of a live session the sidebar filters read. */
export type LiveSidebarSession = {
  id: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  /**
   * Stored origin from `cli_sessions_v2`, present once the session has been
   * ingested. `platform` is the origin the connected CLI reported on its
   * heartbeat, so a live row has one even before ingestion.
   */
  createdOnPlatform?: string;
  platform?: string;
};

export type LiveSidebarQuery = {
  platformFilter: readonly string[];
  projectFilter: readonly string[];
  searchQuery: string;
};

/**
 * Filter values that cover more than one stored platform. The sidebar's
 * platform picker names a platform family; the stored list and the live rows
 * both have to collapse a family through this one map to stay in step.
 */
const PLATFORM_FILTER_VARIANTS: Record<string, readonly string[]> = {
  // 'cloud-agent-web' is a variant of the cloud agent
  'cloud-agent': ['cloud-agent', 'cloud-agent-web'],
  // Extension sessions are created from VS Code or agent-manager
  extension: ['vscode', 'agent-manager'],
};

/** Stored platform values a filter selection covers. Empty selection = no filter. */
export function platformFilterValues(platformFilter: readonly string[]): string[] {
  return platformFilter.flatMap(platform => PLATFORM_FILTER_VARIANTS[platform] ?? [platform]);
}

/**
 * Whether a live row belongs to the current platform selection. A row that
 * reports no origin is claimed by no selection, so a filtered sidebar never
 * shows a session it cannot attribute.
 */
export function matchesLivePlatformFilter(
  session: LiveSidebarSession,
  selectedPlatforms: ReadonlySet<string>
): boolean {
  if (selectedPlatforms.size === 0) return true;
  const origins = [session.createdOnPlatform, session.platform].filter((origin): origin is string =>
    Boolean(origin)
  );
  return origins.some(origin => selectedPlatforms.has(origin));
}

function matchesLiveSearch(session: LiveSidebarSession, needle: string): boolean {
  return [session.title, session.id, session.gitUrl, session.gitBranch].some(value =>
    value?.toLowerCase().includes(needle)
  );
}

/**
 * Client-side filter for the live (Remote) rows: origin, repository, and
 * free text, combined with AND. An empty selection or an empty query means "no
 * filter". The live rows are already in memory, so this filters locally — the
 * stored list is filtered by the same selections server-side.
 *
 * Comparison uses the normalized repository URL so one stored option still
 * matches every spelling of it, matching the stored list's query.
 */
export function filterLiveSidebarSessions<T extends LiveSidebarSession>(
  sessions: readonly T[],
  query: LiveSidebarQuery
): T[] {
  const needle = query.searchQuery.trim().toLowerCase();
  if (query.platformFilter.length === 0 && query.projectFilter.length === 0 && !needle) {
    return [...sessions];
  }
  const selectedPlatforms = new Set(platformFilterValues(query.platformFilter));
  const selectedProjects = new Set(query.projectFilter.map(normalizeGitUrl));
  return sessions.filter(session => {
    const projectMatches =
      selectedProjects.size === 0 ||
      (session.gitUrl != null && selectedProjects.has(normalizeGitUrl(session.gitUrl)));
    return (
      matchesLivePlatformFilter(session, selectedPlatforms) &&
      projectMatches &&
      (!needle || matchesLiveSearch(session, needle))
    );
  });
}
