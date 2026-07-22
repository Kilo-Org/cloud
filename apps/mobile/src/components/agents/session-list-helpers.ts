import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';

import { type AgentSessionDateGroup } from '@/lib/agent-session-groups';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { platformLabel } from '@/lib/platform-label';
import { parseTimestamp, timeAgo } from '@/lib/utils';

// Re-exported so existing importers of `platformLabel` from this module keep
// working while `@/lib/platform-label` stays the single source of truth for
// the platform→label mapping (no duplicate definition to drift).
export { platformLabel };

/**
 * One stored-history section. Exclusivity against the "Active now" tray is
 * enforced on the history side via `excludeActiveFromGroups`; active sessions
 * no longer appear as `SessionItem`s in any section.
 */
export type SessionSection = {
  title: string;
  data: StoredSession[];
};

const platformExpansion: Record<string, string[]> = {
  'cloud-agent': ['cloud-agent', 'cloud-agent-web'],
  extension: ['vscode', 'agent-manager'],
};

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

export function expandPlatformFilter(filter: string[]): string[] {
  return filter.flatMap(p => platformExpansion[p] ?? [p]);
}

export function formatGitUrlProject(gitUrl: string): string {
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(gitUrl);
  const sshPath = sshMatch?.[1];
  if (sshPath) {
    return stripGitSuffix(sshPath);
  }

  const protocolIndex = gitUrl.indexOf('://');
  if (protocolIndex === -1) {
    return gitUrl;
  }

  const pathStart = gitUrl.indexOf('/', protocolIndex + 3);
  if (pathStart === -1) {
    return gitUrl;
  }

  const [rawPath = ''] = gitUrl.slice(pathStart + 1).split(/[?#]/);
  const pathParts = rawPath.split('/').filter(Boolean);
  const dashIndex = pathParts.indexOf('-');
  const projectParts = dashIndex >= 2 ? pathParts.slice(0, dashIndex) : pathParts;

  if (projectParts.length >= 2) {
    return stripGitSuffix(projectParts.join('/'));
  }

  return gitUrl;
}

export function formatMeta(timestamp: string): string {
  return timeAgo(parseTimestamp(timestamp)).toUpperCase();
}

/**
 * Pinned-tray label for an active session. Reuses `platformLabel` when the
 * origin is known, otherwise falls back to 'LIVE'. An undefined, empty, or
 * 'unknown' origin is treated as unknown and returns 'LIVE' rather than a
 * definitive (and potentially wrong) label.
 */
export function remoteAgentLabel(createdOnPlatform: string | undefined): string {
  if (!createdOnPlatform || createdOnPlatform === 'unknown') {
    return 'LIVE';
  }
  return platformLabel(createdOnPlatform);
}

/**
 * Pinned-tray meta line for an active session. Mirrors `formatMeta` when an
 * `updatedAt` timestamp is available, otherwise falls back to the uppercased
 * status string (matches the legacy RemoteSessionRow behavior).
 */
export function remoteMeta(session: { status: string; updatedAt?: string }): string {
  return session.updatedAt ? formatMeta(session.updatedAt) : session.status.toUpperCase();
}

const KNOWN_PLATFORM_VALUES: readonly string[] = KNOWN_PLATFORMS;

/**
 * Select which active sessions appear in the pinned "Active now" tray.
 *
 * Free-text search is not a parameter: the pinned set ignores search by
 * construction. Filters mirror the server-side platform/project narrowing
 * used by the stored-session list so the tray never shows a session that
 * the user has explicitly filtered out.
 *
 * No dedup against stored pages is performed here — exclusivity is enforced
 * on the history side by Task 3, so this helper stays pure and symmetric.
 */
export function selectPinnedActiveSessions(params: {
  activeSessions: ActiveSession[];
  projectFilter: string[];
  platformFilter: string[];
}): ActiveSession[] {
  const { activeSessions, projectFilter, platformFilter } = params;
  const projectActive = projectFilter.length > 0;
  const platformActive = platformFilter.length > 0;

  const concretePlatforms = platformFilter.filter(p => p !== 'other');
  const includeOther = platformFilter.includes('other');
  const expanded = expandPlatformFilter(concretePlatforms);
  return activeSessions.filter(session => {
    if (projectActive && (!session.gitUrl || !projectFilter.includes(session.gitUrl))) {
      return false;
    }

    if (platformActive) {
      if (!session.createdOnPlatform) {
        return false;
      }
      const knownMatch = expanded.includes(session.createdOnPlatform);
      const otherMatch = includeOther && !KNOWN_PLATFORM_VALUES.includes(session.createdOnPlatform);
      if (!knownMatch && !otherMatch) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Drop sessions whose `session_id` is in the active set from date-bucketed
 * groups, and drop any groups that become empty as a result. Preserves the
 * original group order.
 *
 * The generic is constrained to the intersection of what the helper needs
 * (`session_id`) and what `AgentSessionDateGroup` itself requires
 * (`created_at`/`updated_at`); the Task 3 caller passes
 * `AgentSessionDateGroup<StoredSession>[]` which satisfies both bounds.
 */
export function excludeActiveFromGroups<
  T extends { session_id: string; created_at: string; updated_at: string },
>(groups: AgentSessionDateGroup<T>[], activeSessionIds: Set<string>): AgentSessionDateGroup<T>[] {
  const result: AgentSessionDateGroup<T>[] = [];
  for (const group of groups) {
    const remaining = group.sessions.filter(s => !activeSessionIds.has(s.session_id));
    if (remaining.length > 0) {
      result.push({ label: group.label, sessions: remaining });
    }
  }
  return result;
}
