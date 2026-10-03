import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';

/** The part of a live session the sidebar filters read. */
export type LiveSidebarSession = {
  id: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
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
function matchesLivePlatformBucket(
  session: LiveSidebarSession,
  selectedPlatforms: ReadonlySet<string>
): boolean {
  const bucket = livePlatformBucket(session.createdOnPlatform);
  if (bucket === null) return false;
  return selectedPlatforms.has(bucket);
}

export function matchesLivePlatformFilter(
  session: LiveSidebarSession,
  platformFilter: readonly string[]
): boolean {
  if (platformFilter.length === 0) return true;
  return matchesLivePlatformBucket(session, new Set(platformFilterValues(platformFilter)));
}

/** Matches what the stored list matches: id, title, repository, and branch. */
function matchesLiveSearch(session: LiveSidebarSession, needle: string): boolean {
  return [session.title, session.id, session.gitUrl, session.gitBranch].some(value =>
    value?.toLowerCase().includes(needle)
  );
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
  // Mirrors the stored search: trim, lower-case, one leading `#` stripped. A
  // query that reduces to an empty needle matches nothing rather than
  // everything, which is what the stored search does with it.
  const trimmedQuery = query.searchQuery.trim().toLowerCase();
  const needle = trimmedQuery.startsWith('#') ? trimmedQuery.slice(1) : trimmedQuery;
  const isSearchActive = query.searchQuery.length > 0;
  const selectedPlatforms = new Set(platformFilterValues(query.platformFilter));
  const selectedProjects = new Set(query.projectFilter.map(normalizeGitUrl));
  return sessions.filter(session => {
    const platformMatches =
      selectedPlatforms.size === 0 || matchesLivePlatformBucket(session, selectedPlatforms);
    const projectMatches =
      selectedProjects.size === 0 ||
      (session.gitUrl != null && selectedProjects.has(normalizeGitUrl(session.gitUrl)));
    const searchMatches =
      !isSearchActive || (needle.length > 0 && matchesLiveSearch(session, needle));
    return platformMatches && projectMatches && searchMatches;
  });
}
