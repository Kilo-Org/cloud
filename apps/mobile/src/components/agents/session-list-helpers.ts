import { KNOWN_PLATFORMS } from '@kilocode/app-shared/platforms';

import { i18n } from '@/i18n';
import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { type AgentSessionDateGroup } from '@/lib/agent-session-groups';
import { CURRENCY_ZERO_THRESHOLD, formatCurrency } from '@/lib/format';
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

const platformExpansion: ReadonlyMap<string, string[]> = new Map([
  ['cloud-agent', ['cloud-agent', 'cloud-agent-web']],
  ['extension', ['vscode', 'agent-manager']],
]);

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value;
}

export function expandPlatformFilter(filter: string[]): string[] {
  return filter.flatMap(p => platformExpansion.get(p) ?? [p]);
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
  return timeAgo(parseTimestamp(timestamp)).toLocaleUpperCase(i18n.language);
}

/**
 * Canonical visible cost for every mobile session surface (list row, detail
 * header, context sheet total).
 *
 * Returns `null` whenever the surface should not display a cost — caller
 * omits the segment/row entirely. Inputs that are `null`, `undefined`, zero,
 * non-positive, or not finite all collapse to `null`.
 *
 * Conversion: microdollars → USD. At or above half a cent (`>= 5000` µ$),
 * two-decimal dollars (e.g. `$0.01`, `$1.23`). Below half a cent, four
 * decimals (e.g. `$0.0031`); values that would render `$0.0000` (1..49 µ$)
 * are omitted instead of a false zero. Formatted with the active language so
 * the currency follows the applied locale.
 */
export function formatSessionTotalCost(microdollars: number | null | undefined): string | null {
  if (microdollars == null || !Number.isFinite(microdollars) || microdollars <= 0) {
    return null;
  }
  const usd = microdollars / 1_000_000;
  if (usd >= 0.005) {
    return formatCurrency(usd, i18n.language, 2);
  }
  if (usd < CURRENCY_ZERO_THRESHOLD) {
    return null;
  }
  return formatCurrency(usd, i18n.language, 4);
}

/**
 * Derive the canonical session total (max of persisted DB µ$ and live client
 * USD sum) plus the sanitized live breakdown input.
 *
 * Session cost is monotonically non-decreasing, so both inputs are lower
 * bounds and `max` is strictly closer to truth. `breakdownCostUsd` is always
 * the sanitized live sum — never the combined total — so per-model breakdown
 * math stays aligned with the live message stream.
 */
export function selectSessionCostInputs(
  persistedMicrodollars: number | null | undefined,
  liveUsd: number
) {
  const persisted =
    persistedMicrodollars != null && Number.isFinite(persistedMicrodollars)
      ? Math.max(0, persistedMicrodollars)
      : 0;
  const live = Number.isFinite(liveUsd) ? Math.max(0, Math.round(liveUsd * 1_000_000)) : 0;
  const total = Math.max(persisted, live);
  return {
    totalMicrodollars: total > 0 ? total : null,
    breakdownCostUsd: Number.isFinite(liveUsd) ? Math.max(0, liveUsd) : 0,
  };
}

/**
 * Compose the visible `meta` string for a stored session row by folding an
 * optional cost segment in front of the relative timestamp. `cost === null`
 * means the row should render the timestamp alone (the common case for
 * in-progress, old, or zero-cost sessions).
 */
export function composeStoredSessionVisibleMeta(cost: string | null, timeMeta: string): string {
  return cost ? `${cost} · ${timeMeta}` : timeMeta;
}

/**
 * Compose the spoken `meta` string for a stored session row's accessibility
 * label. When `cost === null`, the spoken meta is just the time phrase.
 * Otherwise cost is spoken first ("cost 12 cents, 5 minutes ago"), matching
 * the visible "$0.12 · 5M AGO" order.
 */
export function composeStoredSessionSpokenMeta(cost: string | null, timeSpoken: string): string {
  return cost ? `cost ${cost}, ${timeSpoken}` : timeSpoken;
}

/**
 * Compose the visible `meta` string for an active-session row by folding an
 * optional cost segment in front of the relative timestamp. All four quadrants:
 *   - both → `$cost · timeMeta`
 *   - cost only → `cost`
 *   - time only → `timeMeta`
 *   - neither → `undefined`
 *
 * Used in `RemoteSessionRow` where `timeMeta` comes from `remoteMeta()` (may
 * return `undefined` when no timestamp exists — bare-live dot).
 */
export function composeActiveSessionVisibleMeta(
  cost: string | null,
  timeMeta: string | undefined
): string | undefined {
  if (cost && timeMeta) {
    return `${cost} · ${timeMeta}`;
  }
  if (cost) {
    return cost;
  }
  if (timeMeta) {
    return timeMeta;
  }
  return undefined;
}

/**
 * Compose the spoken `meta` string for an active-session row's accessibility
 * label. All four quadrants:
 *   - both → `cost <costSpoken>, <timeSpoken>`
 *   - cost only → `cost <costSpoken>`
 *   - time only → `timeSpoken`
 *   - neither → `null`
 *
 * The `cost` param is the `formatSpokenCost` phrase (e.g. `"12 cents"`), never
 * the visible `"$"` string, matching the convention in
 * `composeStoredSessionSpokenMeta`.
 */
export function composeActiveSessionSpokenMeta(
  cost: string | null,
  timeSpoken: string | null
): string | null {
  if (cost && timeSpoken) {
    return `cost ${cost}, ${timeSpoken}`;
  }
  if (cost) {
    return `cost ${cost}`;
  }
  if (timeSpoken) {
    return timeSpoken;
  }
  return null;
}

/**
 * Selector for the spoken meta of a remote session row. When `needsInput`
 * is true, spoken cost/time are suppressed entirely (`null`) — the spoken
 * label announces "needs input" instead via `sessionRowAccessibilityLabel`.
 * Otherwise delegates to `composeActiveSessionSpokenMeta`.
 */
export function selectRemoteRowSpokenMeta(params: {
  needsInput: boolean;
  costSpoken: string | null;
  timeSpoken: string | null;
}): string | null {
  if (params.needsInput) {
    return null;
  }
  return composeActiveSessionSpokenMeta(params.costSpoken, params.timeSpoken);
}

/**
 * Pinned-tray label for an active session. Reuses `platformLabel` when the
 * origin is known, otherwise falls back to 'LIVE'. An undefined, empty, or
 * 'unknown' origin is treated as unknown and returns 'LIVE' rather than a
 * definitive (and potentially wrong) label.
 */
export function remoteAgentLabel(createdOnPlatform: string | undefined): string {
  if (!createdOnPlatform || createdOnPlatform === 'unknown') {
    return i18n.t('agents.sessionList.live');
  }
  return platformLabel(createdOnPlatform);
}

/**
 * Timestamp for an active-row meta line: prefer last agent activity, fall back
 * to row `updatedAt`. Absent both → `undefined` (live dot alone).
 */
export function activeSessionMetaTimestamp(session: {
  updatedAt?: string;
  lastActivityAt?: string;
}): string | undefined {
  return session.lastActivityAt ?? session.updatedAt;
}

/**
 * Pinned-tray meta line for an active session. Prefers `lastActivityAt`, falls
 * back to `updatedAt`; otherwise `undefined` so `SessionRow` renders the live
 * dot alone. Never the CLI status — status words in the timestamp slot were a
 * defect (BUSY/IDLE/RETRY).
 */
export function remoteMeta(session: {
  updatedAt?: string;
  lastActivityAt?: string;
}): string | undefined {
  const ts = activeSessionMetaTimestamp(session);
  return ts ? formatMeta(ts) : undefined;
}

/**
 * Pure helper: extract the repo's last path segment from a git URL, using the
 * same SSH/https handling as the list-grouping logic. Returns null when the
 * URL is missing so callers can fall back to a platform label. Exposed for the
 * unified row wrappers' eyebrow label and its unit tests.
 */
export function repoNameFromGitUrl(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) {
    return null;
  }
  const project = formatGitUrlProject(gitUrl);
  const parts = project.split('/');
  return parts.at(-1) ?? project;
}

/**
 * Canonical eyebrow label for a stored session: repo name (uppercased) when
 * a git URL is present, else the platform fallback. Replaces the legacy
 * platform-only label in the Agents list.
 */
export function storedSessionEyebrowLabel(session: {
  git_url: string | null;
  created_on_platform: string;
}): string {
  const repo = repoNameFromGitUrl(session.git_url);
  return repo ? repo.toUpperCase() : platformLabel(session.created_on_platform);
}

/**
 * Canonical eyebrow label for a remote (active) session: repo name
 * (uppercased) when a git URL is present, else the LIVE/CLI origin fallback
 * via `remoteAgentLabel` (preserves the origin-not-heartbeat behavior — live
 * CLI sessions start with origin 'unknown' and get the neutral 'LIVE' label).
 */
export function remoteSessionEyebrowLabel(session: {
  gitUrl?: string | null;
  createdOnPlatform?: string;
}): string {
  const repo = repoNameFromGitUrl(session.gitUrl);
  return repo ? repo.toUpperCase() : remoteAgentLabel(session.createdOnPlatform);
}

/**
 * Whether the Active now row's long-press menu may offer Exit session.
 * Cloud-agent rows carry the sentinel `connectionId` and have no CLI
 * connection to receive `exit_cli`; only real CLI rows can be exited.
 */
export function canExitSessionFromList(session: { connectionId: string }): boolean {
  return session.connectionId !== CLOUD_AGENT_CONNECTION_ID;
}

const KNOWN_PLATFORM_VALUES: readonly string[] = KNOWN_PLATFORMS;

/**
 * Select which active sessions appear in the pinned "Active now" tray.
 *
 * `searchQuery` narrows the tray with the same semantics as the
 * server-side history search: a case-insensitive substring match on the
 * session's `title` OR `id` (`position()`/`includes` — LIKE wildcards
 * match literally). Empty or whitespace-only queries perform no narrowing.
 * The text query applies in conjunction with the platform/project filters,
 * which mirror the server-side narrowing used by the stored-session list.
 *
 * No dedup against stored pages is performed here — exclusivity is enforced
 * on the history side by Task 3, so this helper stays pure and symmetric.
 */
export function selectPinnedActiveSessions(params: {
  activeSessions: ActiveSession[];
  projectFilter: string[];
  platformFilter: string[];
  searchQuery: string;
}): ActiveSession[] {
  const { activeSessions, projectFilter, platformFilter, searchQuery } = params;
  const projectActive = projectFilter.length > 0;
  const platformActive = platformFilter.length > 0;
  const needle = searchQuery.trim().toLowerCase();

  const concretePlatforms = platformFilter.filter(p => p !== 'other');
  const includeOther = platformFilter.includes('other');
  const expanded = expandPlatformFilter(concretePlatforms);
  return activeSessions.filter(session => {
    if (needle.length > 0) {
      const hayTitle = session.title.toLowerCase();
      const hayId = session.id.toLowerCase();
      if (!hayTitle.includes(needle) && !hayId.includes(needle)) {
        return false;
      }
    }

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
