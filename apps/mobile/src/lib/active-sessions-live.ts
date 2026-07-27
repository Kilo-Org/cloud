/**
 * Pure helpers for the app-level active-sessions live-sync owner.
 *
 * WS payloads lack enrichment fields (`createdOnPlatform`/`createdAt`/
 * `updatedAt`); the merge helpers preserve those fields for ids already in
 * the cache while letting every other field (including `connectionId`)
 * come from the latest WS payload, so session ownership can transfer
 * between CLI connections. `capabilities` is the hybrid exception: the WS
 * value wins when present (upgrade or downgrade), and the cached value is
 * preserved only when the WS row omits the field. The functions here never
 * touch React, the network, or a QueryClient — they are pure and
 * exhaustively unit-tested alongside this file.
 *
 * Status resolution for live rows: CLI heartbeats/snapshots often report
 * only idle/busy while `cli_sessions_v2` holds question/permission. A
 * held attention status is sticky across WS snapshots and heartbeats;
 * only an explicit `session.status.updated` (or disconnect) clears it.
 */

import {
  type CliConnectionData,
  cliConnectionDataSchema,
  type HeartbeatData,
  heartbeatDataSchema,
  type SessionsListData,
  sessionsListDataSchema,
  type SessionStatusUpdatedPayload,
  sessionStatusUpdatedPayloadSchema,
} from 'cloud-agent-sdk/schemas';

import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

/** Incoming WS row; carries `parentSessionId` for the root filter. */
type IncomingWsSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  parentSessionId?: string;
  connectionId?: string;
  capabilities?: { attachments?: boolean };
};

/** Cached active session (tRPC output); enrichment fields preserved across WS. */
export type CachedActiveSession = ActiveSession;

export type CachedActiveSessionsData = {
  sessions: CachedActiveSession[];
};

const ENRICHMENT_FIELDS = ['createdOnPlatform', 'createdAt', 'updatedAt'] as const;
type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

/** Structured question/permission — the Active Now "NEEDS INPUT" badge. */
export function isAttentionStatus(status: string | null | undefined): boolean {
  return status === 'question' || status === 'permission';
}

/**
 * Prefer stored attention over live idle/busy so released-CLI heartbeats
 * do not clear NEEDS INPUT. Non-attention stored values yield to live.
 */
export function effectiveStatus(
  live: string | null | undefined,
  stored: string | null | undefined
): string {
  if (isAttentionStatus(stored) && stored != null) {
    return stored;
  }
  return live ?? '';
}

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

/**
 * Dual-shaped `session.status.updated` (full session row vs lightweight
 * sessionId). Null payload status becomes `''` for the cache string field.
 */
export function parseSessionStatusUpdatedPayload(
  value: unknown
): { sessionId: string; status: string } | null {
  const parsed = sessionStatusUpdatedPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const data: SessionStatusUpdatedPayload = parsed.data;
  if ('session' in data) {
    return {
      sessionId: data.session.sessionId,
      status: data.status ?? data.session.status ?? '',
    };
  }
  return {
    sessionId: data.sessionId,
    status: data.status ?? '',
  };
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
    // Sticky attention: a non-attention WS status must not clear a held
    // question/permission. "stored" for WS paths is the cached row status.
    status: effectiveStatus(row.status, current?.status),
    title: row.title,
    gitUrl: row.gitUrl,
    gitBranch: row.gitBranch,
    connectionId,
    // Wire capabilities win when present (upgrade and downgrade); cache
    // only when the WS row omits the field (legacy payloads).
    capabilities: row.capabilities ?? current?.capabilities,
    ...enrichment,
  };
}

/**
 * Replace the entire cache with the snapshot. Rows whose id is in both
 * the snapshot and the cache keep the three enrichment fields and any
 * held attention status from the cache; `capabilities` comes from the
 * snapshot when present and from the cache when omitted; every other
 * field (including `connectionId`) comes from the snapshot. Rows absent
 * from the snapshot are dropped.
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
 *
 * A non-attention heartbeat status does not overwrite a currently-held
 * attention status (sticky overlay for released CLIs).
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

/**
 * Apply an explicit status transition (including leaving attention).
 * Unknown session ids are ignored — live cache only holds active rows.
 */
export function applySessionStatusUpdated(
  current: readonly CachedActiveSession[],
  sessionId: string,
  status: string
): CachedActiveSession[] {
  return current.map(row =>
    row.id === sessionId && row.status !== status ? { ...row, status } : row
  );
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

/** Actions produced by routing a live-sync system event. */
type LiveSystemEventAction =
  | { type: 'write'; updater: (current: readonly CachedActiveSession[]) => CachedActiveSession[] }
  | { type: 'refresh'; reason: 'cli-connected' | 'cli-disconnected' };

/**
 * Pure routing for ActiveSessionsLiveSync system events. session.status.updated
 * is included here so the owner can handle it via onSystemEvent only.
 */
export function planLiveSystemEventActions(event: {
  event: string;
  data: unknown;
}): LiveSystemEventAction[] {
  if (event.event === 'sessions.list') {
    const sessions = parseSessionsListPayload(event.data);
    if (!sessions) {
      return [];
    }
    const roots = selectRootWsSessions(sessions);
    return [{ type: 'write', updater: current => mergeSnapshotForActiveSessions(current, roots) }];
  }
  if (event.event === 'sessions.heartbeat') {
    const payload = parseHeartbeatPayload(event.data);
    if (!payload) {
      return [];
    }
    const roots = selectRootWsSessions(payload.sessions);
    return [
      {
        type: 'write',
        updater: current =>
          mergeHeartbeatForActiveSessions(current, {
            connectionId: payload.connectionId,
            sessions: roots,
          }),
      },
    ];
  }
  if (event.event === 'session.status.updated') {
    const payload = parseSessionStatusUpdatedPayload(event.data);
    if (!payload) {
      return [];
    }
    return [
      {
        type: 'write',
        updater: current => applySessionStatusUpdated(current, payload.sessionId, payload.status),
      },
    ];
  }
  if (event.event === 'cli.disconnected') {
    const payload = parseCliConnectionPayload(event.data);
    if (!payload) {
      return [];
    }
    return [
      {
        type: 'write',
        updater: current => removeActiveSessionsForConnection(current, payload.connectionId),
      },
      { type: 'refresh', reason: 'cli-disconnected' },
    ];
  }
  if (event.event === 'cli.connected' && parseCliConnectionPayload(event.data)) {
    return [{ type: 'refresh', reason: 'cli-connected' }];
  }
  return [];
}
