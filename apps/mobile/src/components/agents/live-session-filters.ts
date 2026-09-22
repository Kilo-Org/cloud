import {
  formatGitUrlProject,
  knownPlatformBucket,
  PLATFORM_FILTERS,
  type ProjectFilterOption,
  projectOptionKey,
} from '@/components/agents/session-list-helpers';

/** The part of an active session the live filters read. */
export type LiveFilterSession = {
  id?: string;
  title?: string;
  gitUrl?: string | null;
  gitBranch?: string;
  createdOnPlatform?: string;
  associatedPr?: { number?: number; title?: string | null } | null;
};

export type LiveSessionQuery = {
  platformFilter: readonly string[];
  projectFilter: readonly string[];
  /** Free text, matched against the session title and metadata. */
  searchQuery: string;
};

export type LiveFilterOptions = {
  projectOptions: ProjectFilterOption[];
  platformOptions: string[];
};

/**
 * Filter bucket for one live row's origin. Returns null when the origin is
 * missing or still 'unknown' (a CLI row before its first enrichment), so such
 * a row offers no option and is never claimed by a platform filter. The
 * variant→bucket mapping lives in `knownPlatformBucket` so there is one place
 * to keep in sync.
 */
export function liveSessionPlatformBucket(createdOnPlatform: string | undefined): string | null {
  if (!createdOnPlatform || createdOnPlatform === 'unknown') {
    return null;
  }
  return knownPlatformBucket(createdOnPlatform) ?? 'other';
}

/**
 * Build the filter options from the live rows themselves, so the picker never
 * offers a repository or an origin that has nothing running. Options are
 * derived from the unfiltered set, so applying a filter does not shrink them.
 * Repositories that render to the same label are one option (first git URL
 * wins), so the sheet never shows the same project twice.
 */
export function buildLiveFilterOptions(sessions: readonly LiveFilterSession[]): LiveFilterOptions {
  const projects = new Map<string, ProjectFilterOption>();
  const platforms = new Set<string>();
  for (const session of sessions) {
    if (session.gitUrl) {
      const key = projectOptionKey(session.gitUrl);
      if (!projects.has(key)) {
        projects.set(key, {
          gitUrl: session.gitUrl,
          displayName: formatGitUrlProject(session.gitUrl),
        });
      }
    }
    const bucket = liveSessionPlatformBucket(session.createdOnPlatform);
    if (bucket) {
      platforms.add(bucket);
    }
  }
  return {
    projectOptions: [...projects.values()]
      // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; the spread already copies so nothing shared is mutated
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    // Keep the canonical platform order the filter modal uses.
    platformOptions: PLATFORM_FILTERS.filter(bucket => platforms.has(bucket)),
  };
}

function matchesSearch(session: LiveFilterSession, needle: string): boolean {
  return [
    session.title,
    session.id,
    session.gitUrl,
    session.gitUrl ? formatGitUrlProject(session.gitUrl) : undefined,
    session.gitBranch,
    session.associatedPr?.title,
    session.associatedPr?.number?.toString(),
  ].some(value => value?.toLowerCase().includes(needle));
}

/**
 * Client-side live-list query: repository, origin, and free-text search, all
 * combined with AND. An empty selection or an empty query means "no filter".
 * The live list is fully loaded in memory, so it filters locally — no refetch,
 * and no debounce needed.
 */
export function filterLiveSessions<T extends LiveFilterSession>(
  sessions: T[],
  query: LiveSessionQuery
): T[] {
  const { platformFilter, projectFilter } = query;
  const needle = query.searchQuery.trim().toLowerCase();
  if (platformFilter.length === 0 && projectFilter.length === 0 && needle.length === 0) {
    return sessions;
  }
  // Match by visible-label identity, not by the raw stored URL, so one stored
  // URL still matches every row the merged option covers (https vs ssh, a
  // `.git` suffix, host case).
  const projectKeys = new Set(projectFilter.map(gitUrl => projectOptionKey(gitUrl)));
  return sessions.filter(session => {
    const bucket = liveSessionPlatformBucket(session.createdOnPlatform);
    const platformMatches =
      platformFilter.length === 0 || (bucket !== null && platformFilter.includes(bucket));
    const projectMatches =
      projectFilter.length === 0 ||
      (session.gitUrl != null && projectKeys.has(projectOptionKey(session.gitUrl)));
    const searchMatches = needle.length === 0 || matchesSearch(session, needle);
    return platformMatches && projectMatches && searchMatches;
  });
}
