import {
  expandPlatformFilter,
  formatGitUrlProject,
  PLATFORM_FILTERS,
  type ProjectFilterOption,
} from '@/components/agents/session-list-helpers';

/** The part of an active session the live filters read. */
export type LiveFilterSession = {
  gitUrl?: string | null;
  createdOnPlatform?: string;
};

export type LiveFilterOptions = {
  projectOptions: ProjectFilterOption[];
  platformOptions: string[];
};

// Inverse of the history screen's platform expansion, so the live list speaks
// the same vocabulary ('cloud-agent' covers 'cloud-agent-web', 'extension'
// covers 'vscode' and 'agent-manager'). Built from `expandPlatformFilter` so
// the mapping stays in one place.
const BUCKET_BY_PLATFORM = new Map<string, string>(
  PLATFORM_FILTERS.filter(bucket => bucket !== 'other').flatMap(bucket =>
    expandPlatformFilter([bucket]).map(platform => [platform, bucket] as const)
  )
);

/**
 * Filter bucket for one live row's origin. Returns null when the origin is
 * missing or still 'unknown' (a CLI row before its first enrichment), so such
 * a row offers no option and is never claimed by a platform filter.
 */
export function liveSessionPlatformBucket(createdOnPlatform: string | undefined): string | null {
  if (!createdOnPlatform || createdOnPlatform === 'unknown') {
    return null;
  }
  return BUCKET_BY_PLATFORM.get(createdOnPlatform) ?? 'other';
}

/**
 * Build the filter options from the live rows themselves, so the picker never
 * offers a repository or an origin that has nothing running. Options are
 * derived from the unfiltered set, so applying a filter does not shrink them.
 */
export function buildLiveFilterOptions(sessions: readonly LiveFilterSession[]): LiveFilterOptions {
  const projects = new Map<string, string>();
  const platforms = new Set<string>();
  for (const session of sessions) {
    if (session.gitUrl) {
      projects.set(session.gitUrl, formatGitUrlProject(session.gitUrl));
    }
    const bucket = liveSessionPlatformBucket(session.createdOnPlatform);
    if (bucket) {
      platforms.add(bucket);
    }
  }
  return {
    projectOptions: [...projects]
      .map(([gitUrl, displayName]) => ({ gitUrl, displayName }))
      // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; map already copies so nothing shared is mutated
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    // Keep the canonical platform order the filter modal uses.
    platformOptions: PLATFORM_FILTERS.filter(bucket => platforms.has(bucket)),
  };
}

/**
 * Client-side live-list filter. An empty selection means "no filter"; the two
 * dimensions combine with AND. The live list is fully loaded in memory, so it
 * filters locally instead of refetching.
 */
export function filterLiveSessions<T extends LiveFilterSession>(
  sessions: T[],
  platformFilter: readonly string[],
  projectFilter: readonly string[]
): T[] {
  if (platformFilter.length === 0 && projectFilter.length === 0) {
    return sessions;
  }
  return sessions.filter(session => {
    const bucket = liveSessionPlatformBucket(session.createdOnPlatform);
    const platformMatches =
      platformFilter.length === 0 || (bucket !== null && platformFilter.includes(bucket));
    const projectMatches =
      projectFilter.length === 0 ||
      (session.gitUrl != null && projectFilter.includes(session.gitUrl));
    return platformMatches && projectMatches;
  });
}
