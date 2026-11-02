import { i18n } from '@/i18n';
import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { CURRENCY_ZERO_THRESHOLD, formatCurrency } from '@/lib/format';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { dateTimeFormat } from '@/lib/intl-cache';
import { platformLabel } from '@/lib/platform-label';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * One stored-history section. A stored session that is also live still
 * appears in its section; the stored list is rendered as-is.
 */
export type SessionSection = {
  title: string;
  data: StoredSession[];
};

/** Platform buckets offered by the session filters, in display order. */
export const PLATFORM_FILTERS = [
  'cloud-agent',
  'extension',
  'desktop',
  'cli',
  'slack',
  'github',
  'linear',
  'other',
] as const;

/** One repository the session filters can select. */
export type ProjectFilterOption = {
  gitUrl: string;
  displayName: string;
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

// Inverse of `expandPlatformFilter` for the UI buckets, so the live list and the
// filter sheet speak the same vocabulary ('cloud-agent' covers
// 'cloud-agent-web', 'extension' covers 'vscode' and 'agent-manager'). Built
// from `expandPlatformFilter` so the mapping stays in one place.
const BUCKET_BY_PLATFORM = new Map<string, string>(
  PLATFORM_FILTERS.filter(bucket => bucket !== 'other').flatMap(bucket =>
    expandPlatformFilter([bucket]).map(platform => [platform, bucket] as const)
  )
);

const PLATFORM_BUCKETS = new Set<string>(PLATFORM_FILTERS);

/**
 * Inverse of `expandPlatformFilter` for the UI buckets: a platform variant
 * maps to its bucket (`cloud-agent-web` -> `cloud-agent`, `vscode` and
 * `agent-manager` -> `extension`), a bucket maps to itself, and anything else
 * returns null. Used to collapse a persisted variant into the single row the
 * filter sheet offers for its bucket.
 */
export function knownPlatformBucket(platform: string): string | null {
  if (PLATFORM_BUCKETS.has(platform)) {
    return platform;
  }
  return BUCKET_BY_PLATFORM.get(platform) ?? null;
}

/**
 * Collapse a persisted platform selection into the bucket rows the filter sheet
 * renders: a stored variant maps to its bucket (`cloud-agent-web` ->
 * `cloud-agent`, `vscode` and `agent-manager` -> `extension`), a bucket maps to
 * itself, and an unknown platform keeps its own value. Deduplicated, so a
 * bucket saved alongside one of its variants is one entry.
 *
 * The badge count and the sheet already speak this vocabulary; the live-list
 * comparison and the history query use this so a legacy selection behaves the
 * same way everywhere: one checked row means one active filter that covers each
 * of that row's raw platforms.
 */
export function normalisePlatformSelection(filter: readonly string[]): string[] {
  return [...new Set(filter.map(platform => knownPlatformBucket(platform) ?? platform))];
}

/**
 * Decode every segment of a git URL path. Splitting before decoding keeps an
 * encoded slash inside its own segment, so the path keeps the boundaries the
 * raw URL had. A malformed escape (a lone `%` or a truncated sequence) cannot
 * be decoded, and its raw segment is kept instead of throwing: one bad segment
 * never blanks the label.
 */
function decodePathSegments(path: string): string {
  return path
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/**
 * Render a git URL as the `owner/repo` path its labels and filter keys show.
 * Segments are percent-decoded because a session stores the encoded URL while
 * the repository's own name is the decoded one, and each segment is decoded
 * once: a name holding a literal `%` stays intact.
 */
export function formatGitUrlProject(gitUrl: string): string {
  const sshMatch = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(gitUrl);
  const sshPath = sshMatch?.[1];
  if (sshPath) {
    return stripGitSuffix(decodePathSegments(sshPath));
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
    return stripGitSuffix(decodePathSegments(projectParts.join('/')));
  }

  return gitUrl;
}

/**
 * Identity of a repository filter option: the visible label, trimmed and
 * case-folded. Two git URLs (https vs ssh, a `.git` suffix, host case) that
 * `formatGitUrlProject` renders identically share one key, so the filter sheet
 * offers them as a single row and one stored URL matches every row the merged
 * option covers. Case-folds with the active locale (bare `toLowerCase()` is
 * banned by `src/lib/case-guard.test.ts`); both sides of every comparison are
 * folded in the same locale, so the key stays a stable comparison key.
 */
export function projectOptionKey(gitUrl: string): string {
  return formatGitUrlProject(gitUrl).trim().toLocaleLowerCase(i18n.language);
}

/**
 * Relative-time label for a row's meta line. `nowMs` is the caller's sampled
 * clock so a memoized row can pass the tick that re-rendered it instead of
 * reading `Date.now()` behind the memo (see `useNowTicker`); omitted, the
 * formatter reads the current time.
 */
export function formatMeta(timestamp: string | null | undefined, nowMs?: number): string {
  const date = parseTimestamp(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : timeAgo(date, undefined, nowMs).toLocaleUpperCase(i18n.language);
}

/**
 * Time of day of a row's own timestamp, in the active language
 * (e.g. `"9:00 AM"`), for a label that carries no relative day.
 *
 * Returns `null` when the timestamp does not parse, so a caller shows nothing
 * rather than an `"Invalid Date"` or a midnight the record never held.
 */
function clockTime(timestamp: string | null | undefined): string | null {
  const date = parseTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return dateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * Clock time of a scheduled session's wake, for the `SCHEDULED · <wake>`
 * eyebrow. `null` when the timestamp does not parse, so a missing or garbage
 * `scheduledAt` shows the `SCHEDULED` label with no time; the caller appends
 * the value only when it is non-null.
 */
export function formatScheduledWake(at: string): string | null {
  return clockTime(at);
}

/**
 * Time meta for one session row: the label the row draws, plus the clock time
 * when the relative label was replaced because it restated the row's section.
 */
type SessionRowTimeMeta = {
  visible: string;
  /** The clock time that replaced the relative label, or `null` when it stands. */
  clock: string | null;
};

/**
 * Time meta for a session row that sits under a date section heading.
 *
 * `formatMeta` renders the relative day word, and in the Yesterday section that
 * word is the heading directly above the row (`YESTERDAY` under `YESTERDAY`),
 * so the row restated its own section. When the two strings match — the same
 * locale-folded text on screen, not a bucket rule — the row shows the clock
 * time of its own timestamp instead. Every other heading (Today, a weekday,
 * Older) never matches the relative label it renders, so those rows keep it.
 *
 * `clock` is the replacement when one was made, so the spoken label says the
 * same clock time instead of repeating the section, and `null` when the
 * relative label stands. `nowMs` is the caller's sampled clock, as in
 * {@link formatMeta}.
 */
export function sectionAwareTimeMeta(
  timestamp: string | null | undefined,
  sectionTitle: string | null | undefined,
  nowMs?: number
): SessionRowTimeMeta {
  const relative = formatMeta(timestamp, nowMs);
  if (!sectionTitle || relative === '') {
    return { visible: relative, clock: null };
  }
  if (
    relative.toLocaleLowerCase(i18n.language) !==
    sectionTitle.trim().toLocaleLowerCase(i18n.language)
  ) {
    return { visible: relative, clock: null };
  }
  const clock = clockTime(timestamp);
  return clock === null ? { visible: relative, clock: null } : { visible: clock, clock };
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
  return composeActiveSessionVisibleMeta(cost, timeMeta) ?? '';
}

/**
 * Compose the spoken `meta` string for a stored session row's accessibility
 * label. When `cost === null`, the spoken meta is just the time phrase.
 * Otherwise cost is spoken first ("cost 12 cents, 5 minutes ago"), matching
 * the visible "$0.12 · 5M AGO" order.
 */
export function composeStoredSessionSpokenMeta(cost: string | null, timeSpoken: string): string {
  return composeActiveSessionSpokenMeta(cost, timeSpoken) ?? '';
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
    return i18n.t('agents.sessionRow.costSpokenWithTime', { cost, time: timeSpoken });
  }
  if (cost) {
    return i18n.t('agents.sessionRow.costSpoken', { cost });
  }
  if (timeSpoken) {
    return timeSpoken;
  }
  return null;
}

export function selectRemoteRowSpokenMeta(params: {
  variant: 'card' | 'list';
  scheduled: boolean;
  scheduledWake: string | null;
  needsInput: boolean;
  costSpoken: string | null;
  timeSpoken: string | null;
}): string | null {
  if (params.variant === 'list') {
    const parts = [
      params.scheduledWake,
      composeActiveSessionSpokenMeta(params.costSpoken, params.timeSpoken),
    ].filter(Boolean);
    // Intl unit lists still add a conjunction in Arabic; the outer label owns its connector.
    return parts.join(', ') || null;
  }
  if (params.scheduled) {
    return params.scheduledWake;
  }
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
 * defect (BUSY/IDLE/RETRY). `nowMs` is the caller's sampled clock, so a
 * memoized row ages its own label (see {@link formatMeta}).
 */
export function remoteMeta(
  session: {
    updatedAt?: string;
    lastActivityAt?: string;
  },
  nowMs?: number
): string | undefined {
  const ts = activeSessionMetaTimestamp(session);
  return ts ? formatMeta(ts, nowMs) : undefined;
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
  return repo ? repo.toLocaleUpperCase(i18n.language) : platformLabel(session.created_on_platform);
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
  return repo ? repo.toLocaleUpperCase(i18n.language) : remoteAgentLabel(session.createdOnPlatform);
}

/**
 * Whether the Active now row's long-press menu may offer Exit session.
 * Cloud-agent rows carry the sentinel `connectionId` and have no CLI
 * connection to receive `exit_cli`; only real CLI rows can be exited.
 */
export function canExitSessionFromList(session: { connectionId: string }): boolean {
  return session.connectionId !== CLOUD_AGENT_CONNECTION_ID;
}

/**
 * Compose the provenance subtitle for a session row.
 *
 *   - both branch and PR number → `"branch · #N"`
 *   - branch only → the branch
 *   - PR number only → `"#N"`
 *   - neither → `null`
 */
export function composeSessionProvenanceSubtitle(params: {
  branch: string | null | undefined;
  prNumber: number | null | undefined;
}): string | null {
  const { branch, prNumber } = params;
  const hasBranch = branch != null && branch !== '';
  const hasPr = prNumber != null;
  if (hasBranch && hasPr) {
    return `${branch} · #${prNumber}`;
  }
  if (hasBranch) {
    return branch;
  }
  if (hasPr) {
    return `#${prNumber}`;
  }
  return null;
}
