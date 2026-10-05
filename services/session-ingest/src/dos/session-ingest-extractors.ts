import { isValidGitUrl, sanitizeGitUrl } from '@kilocode/worker-utils/git-url';
import type { IngestBatch } from '../types/session-sync';

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function extractNormalizedTitleFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'session') return undefined;
  return normalizeOptionalString((item.data as { title?: unknown } | null | undefined)?.title);
}

export function extractNormalizedParentIdFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'session') return undefined;
  return normalizeOptionalString(
    (item.data as { parentID?: unknown } | null | undefined)?.parentID
  );
}

export function extractNormalizedPlatformFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'kilo_meta') return undefined;
  return normalizeOptionalString(
    (item.data as { platform?: unknown } | null | undefined)?.platform
  );
}

export function extractNormalizedOrgIdFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'kilo_meta') return undefined;
  return normalizeOptionalString((item.data as { orgId?: unknown } | null | undefined)?.orgId);
}

export function extractNormalizedGitUrlFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'kilo_meta') return undefined;
  const raw = normalizeOptionalString(
    (item.data as { gitUrl?: unknown } | null | undefined)?.gitUrl
  );
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return isValidGitUrl(raw) ? sanitizeGitUrl(raw) : null;
}

export function extractNormalizedGitBranchFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'kilo_meta') return undefined;
  return normalizeOptionalString(
    (item.data as { gitBranch?: unknown } | null | undefined)?.gitBranch
  );
}

export function extractStatusFromItem(item: IngestBatch[number]): string | null | undefined {
  if (item.type !== 'session_status') return undefined;
  return normalizeOptionalString((item.data as { status?: unknown } | null | undefined)?.status);
}

/**
 * The PR-link tuple, emitted atomically. `prNumber` is serialized to a string so it
 * flows through the same `string | null` change-map channel as every other extractable
 * key; `computeSessionMetadataUpdates` converts it back with `Number`. `prHeadRef` and
 * `prHeadSha` are the session's own per-link evidence, null when the CLI omitted them.
 */
export type SessionPrLinkExtract =
  | {
      prPlatform: string;
      prUrl: string;
      prNumber: string;
      prHeadRef: string | null;
      prHeadSha: string | null;
    }
  | {
      prPlatform: null;
      prUrl: null;
      prNumber: null;
      prHeadRef: null;
      prHeadSha: null;
    };

export function extractSessionPrLink(item: IngestBatch[number]): SessionPrLinkExtract | undefined {
  if (item.type !== 'session_pr_link') return undefined;

  const { platform, prUrl, prNumber, headRef, headSha } = item.data;

  // Any null field clears the whole link: persist null for all five keys.
  if (platform === null || prUrl === null || prNumber === null) {
    return { prPlatform: null, prUrl: null, prNumber: null, prHeadRef: null, prHeadSha: null };
  }

  // A non-null set must be well-formed; otherwise drop all five keys (metadata no-op).
  if (
    typeof platform !== 'string' ||
    platform.length === 0 ||
    typeof prUrl !== 'string' ||
    prUrl.length === 0 ||
    typeof prNumber !== 'number' ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    return undefined;
  }

  // Head evidence is optional: a malformed value reads as absent (null) rather
  // than dropping an otherwise well-formed link, so the repo/head-ref fallback
  // still applies.
  const normalizedHeadRef =
    typeof headRef === 'string' && headRef.trim().length > 0 ? headRef.trim() : null;
  const normalizedHeadSha =
    typeof headSha === 'string' && headSha.trim().length > 0 ? headSha.trim() : null;

  return {
    prPlatform: platform,
    prUrl,
    prNumber: String(prNumber),
    prHeadRef: normalizedHeadRef,
    prHeadSha: normalizedHeadSha,
  };
}
