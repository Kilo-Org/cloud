/**
 * Pure helpers for the app-level active-sessions live-sync owner.
 *
 * WS payloads lack enrichment fields (`createdOnPlatform`/`createdAt`/
 * `updatedAt`) and `organizationId`; the merge helpers preserve those
 * fields for ids already in the cache while letting every other field
 * (including `connectionId`) come from the latest WS payload, so session
 * ownership can transfer between CLI connections. Once a row has been
 * through a tRPC fetch the cached DB title is sticky too — heartbeats
 * never carry a cloud rename. `capabilities` is the hybrid exception: the
 * WS value wins when present (upgrade or downgrade), and the cached value
 * is preserved only when the WS row omits the field. The functions here
 * never touch React, the network, or a QueryClient — they are pure and
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
} from '@kilocode/cloud-agent-sdk/schemas';

import { buildActiveSessionsInput } from '@/lib/agent-session-input';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

/**
 * Sentinel `connectionId` for cloud-agent rows merged into `activeSessions.list`
 * when `includeCloudAgentSessions` is on. Must match the router contract in
 * `apps/web/src/routers/active-sessions-router.ts`. Real CLI connection ids are
 * generated and never equal this literal.
 */
export const CLOUD_AGENT_CONNECTION_ID = 'cloud-agent';

/**
 * Tray list input: the org context plus the cloud-merge opt-in. The live-sync
 * mount and the useAgentSessions hook MUST build identical keys — the WS
 * owner writes into this key, so any mismatch silently splits the cache.
 */
export function buildActiveSessionsTrayInput(organizationId: string | null | undefined) {
  return { ...buildActiveSessionsInput(organizationId), includeCloudAgentSessions: true as const };
}

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

/** The three fields that mark a row as having been through a tRPC fetch. */
const ENRICHMENT_FIELDS = ['createdOnPlatform', 'createdAt', 'updatedAt'] as const;

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

type PreservedFields = {
  createdOnPlatform: string | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  /**
   * Sticky like the three above: WS payloads never carry activity time.
   * Not part of `ENRICHMENT_FIELDS` — the router always sets those three,
   * but `lastActivityAt` may be legitimately absent (NULL in DB).
   */
  lastActivityAt: string | undefined;
  /** Sticky like the three above: WS payloads never carry an org id. */
  organizationId: string | null | undefined;
  /**
   * Sticky: WS payloads never carry total cost. Preserved only when a
   * numeric value exists — absent when the poll never set it (no invented
   * null preservation, exactly the `lastActivityAt` pattern with a number
   * guard).
   */
  totalCostMicrodollars: number | undefined;
};

function readEnrichment(current: CachedActiveSession | undefined): PreservedFields {
  return {
    // Every field here is already `T | undefined` on ActiveSession (the
    // router declares them `.optional()`), so a direct optional-chain read
    // is the field's exact contract — no narrowing needed. `organizationId`
    // is the one exception worth calling out: `null` means "the server said
    // personal" and must pass through as-is, never collapsed to undefined.
    createdOnPlatform: current?.createdOnPlatform,
    createdAt: current?.createdAt,
    updatedAt: current?.updatedAt,
    lastActivityAt: current?.lastActivityAt,
    organizationId: current?.organizationId,
    totalCostMicrodollars: current?.totalCostMicrodollars,
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
    // The tray title is DB-authoritative (the router enriches it from
    // cli_sessions_v2), so once a row has been through a tRPC fetch a heartbeat's
    // CLI title must not overwrite it — nothing propagates a cloud rename back to
    // the CLI, which is what made a renamed session flash its old name. An
    // unenriched row (never joined) still takes the wire title so a just-spawned
    // session shows something immediately.
    title: current && isEnriched(current) ? current.title : row.title,
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
 * Merge a `sessions.list` WS snapshot into the cache. Snapshot rows own the
 * CLI channel only: enrichment/attention/`capabilities` rules match the prior
 * wholesale merge, but cloud-agent sentinel rows absent from the snapshot are
 * preserved. Cloud rows are added/dropped exclusively by tRPC fetches — a
 * CLI-only snapshot must never wipe them.
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
  const merged = snapshot.map(row => {
    snapshotIds.add(row.id);
    return withEnrichmentAndConnectionId(row, currentById.get(row.id), row.connectionId);
  });
  // A sessions.list snapshot owns CLI-channel rows only; cloud rows are
  // added/dropped exclusively by tRPC fetches.
  const preservedCloud = current.filter(
    row => row.connectionId === CLOUD_AGENT_CONNECTION_ID && !snapshotIds.has(row.id)
  );
  return [...merged, ...preservedCloud];
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
 *
 * No cloud-sentinel special case needed: heartbeat payloads never carry
 * `connectionId === CLOUD_AGENT_CONNECTION_ID`, and the keep-loop already
 * retains foreign-connection rows (including the sentinel).
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

/**
 * Optimistic tray rename. Unknown session ids are ignored — the live cache only
 * holds active rows.
 */
export function applyActiveSessionTitle(
  current: readonly CachedActiveSession[],
  sessionId: string,
  title: string
): CachedActiveSession[] {
  return current.map(row =>
    row.id === sessionId && row.title !== title ? { ...row, title } : row
  );
}

/**
 * Keep only the rows belonging to the selected personal/org context:
 * `undefined` = no filter, `null` = personal, a uuid = that organization.
 *
 * The router attributes every row it returns (`null` for a session with no
 * `cli_sessions_v2` row), so an absent `organizationId` here means the row was
 * inserted by the WS push path, which cannot carry one. Such a row is hidden in
 * ANY filtered context — strict equality against a `string | null` context drops
 * it — and reappears once the next tRPC fetch attributes it. Treating unknown as
 * personal instead would re-admit an out-of-context session on every heartbeat,
 * for the whole life of that session (D6).
 */
export function filterActiveSessionsByOrganization<T extends { organizationId?: string | null }>(
  sessions: readonly T[],
  organizationId: string | null | undefined
): T[] {
  if (organizationId === undefined) {
    return [...sessions];
  }
  return sessions.filter(session => session.organizationId === organizationId);
}

/**
 * Ids of every row in the active-sessions cache, WITHOUT the org-context
 * filter. Used to exclude active sessions from stored history the moment the
 * live state exists in the cache — including WS-written rows not yet
 * org-attributed — so a live session never renders as a stored-history twin
 * while it waits for enrichment. The pinned tray itself stays org-filtered,
 * so the pinned set is always a subset of this exclusion set.
 */
export function selectActiveExclusionIds(sessions: readonly { id: string }[]): Set<string> {
  return new Set(sessions.map(s => s.id));
}

/**
 * Drop rows for a disconnected CLI connection. No cloud-sentinel special
 * case needed: CLI disconnect ids never equal `CLOUD_AGENT_CONNECTION_ID`.
 */
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
 * `organizationId` is sticky too but does NOT count — WS-inserted rows
 * never carry it, and the enrichment-retry cadence must not shift.
 */
export function isEnriched(row: CachedActiveSession): boolean {
  return ENRICHMENT_FIELDS.some(field => row[field] !== undefined);
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
