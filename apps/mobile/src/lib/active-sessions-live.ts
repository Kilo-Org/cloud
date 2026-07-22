/**
 * Pure helpers for the app-level active-sessions live-sync owner.
 *
 * WS payloads lack enrichment fields (`createdOnPlatform`/`createdAt`/
 * `updatedAt`); the merge helpers preserve those fields for ids already in
 * the cache while letting every other field (including `connectionId`)
 * come from the latest WS payload, so session ownership can transfer
 * between CLI connections. The functions here never touch React, the
 * network, or a QueryClient — they are pure and exhaustively unit-tested
 * alongside this file.
 */

import {
  type CliConnectionData,
  cliConnectionDataSchema,
  type HeartbeatData,
  heartbeatDataSchema,
  type SessionsListData,
  sessionsListDataSchema,
} from 'cloud-agent-sdk/schemas';

import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

/**
 * Incoming WS session row (per the SDK schemas). Carries
 * `parentSessionId` so the root filter can drop subagent sessions; the
 * cached `ActiveSession` (from the tRPC router) does not.
 */
type IncomingWsSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  parentSessionId?: string;
  connectionId?: string;
};

/**
 * Cached active session: `ActiveSession` (tRPC output) plus the
 * enrichment fields `createdOnPlatform` / `createdAt` / `updatedAt` that
 * the live-sync owner preserves across WS updates.
 */
export type CachedActiveSession = ActiveSession;

export type CachedActiveSessionsData = {
  sessions: CachedActiveSession[];
};

/**
 * The three enrichment fields that the live-sync owner preserves across
 * WS updates. Every other field comes from the latest WS payload (this
 * includes `connectionId`, so ownership transfer between CLIs lands
 * correctly on the next heartbeat/snapshot).
 */
const ENRICHMENT_FIELDS = ['createdOnPlatform', 'createdAt', 'updatedAt'] as const;
type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

function isRootWsSession(session: IncomingWsSession): boolean {
  return !session.parentSessionId;
}

export function selectRootWsSessions<T extends IncomingWsSession>(sessions: readonly T[]): T[] {
  return sessions.filter(session => isRootWsSession(session));
}

// ── Payload parsing (WS trust boundary) ──────────────────────────────

type HeartbeatPayload = {
  connectionId: string;
  sessions: HeartbeatData['sessions'];
};

export function parseHeartbeatPayload(value: unknown): HeartbeatPayload | null {
  const parsed = heartbeatDataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    connectionId: parsed.data.connectionId,
    sessions: parsed.data.sessions,
  };
}

export function parseSessionsListPayload(value: unknown): SessionsListData['sessions'] | null {
  const parsed = sessionsListDataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.sessions;
}

export function parseCliConnectionPayload(value: unknown): CliConnectionData | null {
  const parsed = cliConnectionDataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

// ── Enrichment-preserving merge helpers ──────────────────────────────

function readEnrichment(
  current: CachedActiveSession | undefined
): Record<EnrichmentField, string | undefined> {
  return {
    createdOnPlatform:
      typeof current?.createdOnPlatform === 'string' ? current.createdOnPlatform : undefined,
    createdAt: typeof current?.createdAt === 'string' ? current.createdAt : undefined,
    updatedAt: typeof current?.updatedAt === 'string' ? current.updatedAt : undefined,
  };
}

type WithoutConnectionId<T> = Omit<T, 'connectionId'>;

function withEnrichmentAndConnectionId(
  row: WithoutConnectionId<IncomingWsSession>,
  current: CachedActiveSession | undefined,
  connectionId: string
): CachedActiveSession {
  const enrichment = readEnrichment(current);
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    gitUrl: row.gitUrl,
    gitBranch: row.gitBranch,
    connectionId,
    ...enrichment,
  };
}

/**
 * Replace the entire cache with the snapshot. Rows whose id is in both
 * the snapshot and the cache keep ONLY the three enrichment fields from
 * the cache; every other field (including `connectionId`) comes from the
 * snapshot. Rows absent from the snapshot are dropped.
 */
export function mergeSnapshotForActiveSessions(
  current: readonly CachedActiveSession[],
  snapshot: SessionsListData['sessions']
): CachedActiveSession[] {
  const currentById = new Map<string, CachedActiveSession>();
  for (const row of current) {
    currentById.set(row.id, row);
  }
  const snapshotIds = new Set<string>();
  const result: CachedActiveSession[] = [];
  for (const row of snapshot) {
    snapshotIds.add(row.id);
    const enriched = withEnrichmentAndConnectionId(row, currentById.get(row.id), row.connectionId);
    result.push(enriched);
  }
  return result.filter(row => snapshotIds.has(row.id));
}

/**
 * Heartbeat merge: id-unique with latest-payload-wins.
 *
 * Stronger than web's `applyActiveSessionsHeartbeat`: in addition to
 * dropping cached rows whose `connectionId` matches the payload's
 * connectionId, this also drops cached rows whose session id appears in
 * the payload under a DIFFERENT connectionId — so ownership transfer
 * between CLIs (same session id, new owner) reflects the new owner on
 * the next heartbeat without leaving a stale copy under the old one.
 */
export function mergeHeartbeatForActiveSessions(
  current: readonly CachedActiveSession[],
  payload: HeartbeatPayload
): CachedActiveSession[] {
  const currentById = new Map<string, CachedActiveSession>();
  for (const row of current) {
    currentById.set(row.id, row);
  }
  const payloadIds = new Set<string>();
  for (const row of payload.sessions) {
    payloadIds.add(row.id);
  }

  const result: CachedActiveSession[] = [];
  for (const row of payload.sessions) {
    const enriched = withEnrichmentAndConnectionId(
      row,
      currentById.get(row.id),
      payload.connectionId
    );
    result.push(enriched);
  }
  for (const row of current) {
    if (row.connectionId !== payload.connectionId && !payloadIds.has(row.id)) {
      result.push(row);
    }
  }
  return result;
}

export function removeActiveSessionsForConnection(
  current: readonly CachedActiveSession[],
  connectionId: string
): CachedActiveSession[] {
  return current.filter(row => row.connectionId !== connectionId);
}

/**
 * Heuristic: a row counts as "enriched" when at least one enrichment
 * field is set. Empty `createdOnPlatform` (e.g. `'unknown'`) is still a
 * real value from the tRPC router and counts as enriched; the trpc
 * pipeline is the source of truth for "the DB row has been joined in".
 */
export function isEnriched(row: CachedActiveSession): boolean {
  return (
    typeof row.createdOnPlatform === 'string' ||
    typeof row.createdAt === 'string' ||
    typeof row.updatedAt === 'string'
  );
}

export function hasUnenrichedLiveId(rows: readonly CachedActiveSession[]): boolean {
  return rows.some(row => !isEnriched(row));
}
