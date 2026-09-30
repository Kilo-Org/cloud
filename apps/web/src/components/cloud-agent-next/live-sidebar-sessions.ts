import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';

/** The part of a live session the sidebar filters read. */
export type LiveSidebarSession = {
  id: string;
  title: string;
  gitUrl?: string;
  /**
   * Stored origin from `cli_sessions_v2`, absent until the session has been
   * ingested. The connection's own `platform` is deliberately not read here:
   * that field is the client the CLI runs in ("darwin", "vscode"), not the
   * origin the session was created on.
   */
  createdOnPlatform?: string;
};

export type LiveSidebarQuery = {
  platformFilter: readonly string[];
  projectFilter: readonly string[];
  searchQuery: string;
};

/**
 * Filter values that cover more than one stored platform. The sidebar's
 * platform picker names a platform family, and the stored list and the live
 * rows both collapse a family through this one map to stay in step.
 */
const PLATFORM_FILTER_VARIANTS: Record<string, readonly string[]> = {
  // 'cloud-agent-web' is a variant of the cloud agent
  'cloud-agent': ['cloud-agent', 'cloud-agent-web'],
  // Extension sessions are created from VS Code or agent-manager
  extension: ['vscode', 'agent-manager'],
};

const KNOWN_PLATFORM_VALUES = new Set<string>(KNOWN_PLATFORMS);

/** Stored platform values a filter selection covers. Empty selection = no filter. */
export function platformFilterValues(platformFilter: readonly string[]): string[] {
  return platformFilter.flatMap(platform => PLATFORM_FILTER_VARIANTS[platform] ?? [platform]);
}

/**
 * The filter bucket a stored origin falls in: the origin itself when the
 * platform is known, "other" when it is not — the same split the stored
 * session query makes, where "other" is every platform outside
 * `KNOWN_PLATFORMS`. A row with no reported origin is claimed by no bucket,
 * so a filtered sidebar never shows a session it cannot attribute.
 */
function livePlatformBucket(createdOnPlatform: string | undefined): string | null {
  if (!createdOnPlatform) return null;
  return KNOWN_PLATFORM_VALUES.has(createdOnPlatform) ? createdOnPlatform : 'other';
}

/**
 * Whether a live row belongs to the current platform selection. Mirrors the
 * stored list's query, including "other" matching any origin the platform
 * catalogue does not name.
 */
export function matchesLivePlatformFilter(
  session: LiveSidebarSession,
  platformFilter: readonly string[]
): boolean {
  if (platformFilter.length === 0) return true;
  const bucket = livePlatformBucket(session.createdOnPlatform);
  if (bucket === null) return false;
  const selected = new Set(platformFilterValues(platformFilter));
  return selected.has(bucket);
}

/** Matches what the stored list matches: the session id and its title. */
function matchesLiveSearch(session: LiveSidebarSession, needle: string): boolean {
  return session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle);
}

/**
 * Client-side filter for the live (Remote) rows: origin, repository, and free
 * text, combined with AND. An empty selection or an empty query means "no
 * filter". The live rows are already in memory, so this filters locally — the
 * stored list is filtered by the same selections server-side.
 *
 * Repository comparison normalizes both sides: the option comes from a stored
 * row while the live row carries the URL the connection reported, and the two
 * routinely disagree on spelling.
 */
export function filterLiveSidebarSessions<T extends LiveSidebarSession>(
  sessions: readonly T[],
  query: LiveSidebarQuery
): T[] {
  const needle = query.searchQuery.trim().toLowerCase();
  const selectedProjects = new Set(query.projectFilter.map(normalizeGitUrl));
  return sessions.filter(session => {
    const projectMatches =
      selectedProjects.size === 0 ||
      (session.gitUrl != null && selectedProjects.has(normalizeGitUrl(session.gitUrl)));
    return (
      matchesLivePlatformFilter(session, query.platformFilter) &&
      projectMatches &&
      (!needle || matchesLiveSearch(session, needle))
    );
  });
}
