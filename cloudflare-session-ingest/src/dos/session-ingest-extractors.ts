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

// Validate git URL and strip credentials, query params, and hash.
// Matches the sanitization in cli-sessions-router.ts (V1 sessions).
function normalizeGitUrl(url: string): string | null {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2].split('?')[0];
    return `git@${host}:${path}`;
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
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
  return normalizeGitUrl(raw);
}

export function extractNormalizedGitBranchFromItem(
  item: IngestBatch[number]
): string | null | undefined {
  if (item.type !== 'kilo_meta') return undefined;
  return normalizeOptionalString(
    (item.data as { gitBranch?: unknown } | null | undefined)?.gitBranch
  );
}
