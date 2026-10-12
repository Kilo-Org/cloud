import 'server-only';
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildHomeWidgetData,
  buildHomeWidgetPresentation,
  buildHomeWidgetPresentationTimeline,
  homeWidgetRefreshAt,
  type HomeWidgetResponse,
  type HomeWidgetSessionRow,
} from '@kilocode/app-shared/home-widget';
import { cli_sessions_v2, user_activity_tokens } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { SESSION_LIVE_ACTIVITY_MAX_AGE_MS } from '@kilocode/notifications';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { type ActiveSession, listActiveSessions } from '@/lib/active-sessions-list';
import { readCloudAgentWidgetApprovalKey } from '@/lib/cloud-agent-next/cloud-agent-client';

type HomeWidgetScope = { userId: string; organizationId: string | null };

/**
 * The permission row the widget offers Approve for: the `permission` row with
 * the earliest usable `statusUpdatedAt`, timestamp-less rows last, list order
 * breaking ties. Mirrors mobile `pickFrontApprovableSession`, so the key binds
 * the row the app re-validates against.
 */
function pickFrontPermissionRow(sessions: readonly ActiveSession[]): ActiveSession | null {
  let front: ActiveSession | null = null;
  let frontAt: number | null = null;
  for (const row of sessions) {
    if (row.status !== 'permission') continue;
    const parsed = row.statusUpdatedAt === undefined ? Number.NaN : Date.parse(row.statusUpdatedAt);
    const at = Number.isNaN(parsed) ? null : parsed;
    if (front === null || (at !== null && (frontAt === null || at < frontAt))) {
      front = row;
      frontAt = at;
    }
  }
  return front;
}

/**
 * SHA-256 binding of the one approvable permission, or null. The cloud session
 * lookup is scoped to the same user and organization as the counts, and the
 * Worker re-checks that scope before reading the Session DO's stored pending
 * set (no sandbox wake). Any failure drops only the key: counts and titles stay
 * valid and nothing is fabricated. Logs carry no session, permission or user ids.
 */
async function readApprovalKey(
  scope: HomeWidgetScope,
  front: ActiveSession,
  signal: AbortSignal | undefined
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, front.id),
          eq(cli_sessions_v2.kilo_user_id, scope.userId),
          scope.organizationId === null
            ? isNull(cli_sessions_v2.organization_id)
            : eq(cli_sessions_v2.organization_id, scope.organizationId)
        )
      )
      .limit(1);
    // A remote CLI session has no cloud pending set; the app owns its approval.
    if (!row?.cloudAgentSessionId) return null;
    return await readCloudAgentWidgetApprovalKey(
      {
        ...scope,
        kiloSessionId: front.id,
        cloudAgentSessionId: row.cloudAgentSessionId,
      },
      signal
    );
  } catch (error) {
    console.warn(
      '[home-widget] approval identity unavailable:',
      error instanceof Error ? error.name : 'unknown'
    );
    return null;
  }
}

type ScopeRead = {
  sessions: ActiveSession[];
  front: ActiveSession | null;
  frontApprovalKey: string | null;
  rows: HomeWidgetSessionRow[];
  now: number;
};

async function readScope(
  { userId, organizationId }: HomeWidgetScope,
  signal: AbortSignal | undefined
): Promise<ScopeRead> {
  const { sessions } = await listActiveSessions({
    userId,
    organizationId,
    includeCloudAgentSessions: true,
    requireCompleteSnapshot: true,
    signal,
  });
  const front = pickFrontPermissionRow(sessions);
  const frontApprovalKey =
    front === null ? null : await readApprovalKey({ userId, organizationId }, front, signal);
  const rows: HomeWidgetSessionRow[] =
    frontApprovalKey === null
      ? sessions
      : sessions.map(row => (row === front ? { ...row, approvalKey: frontApprovalKey } : row));
  return { sessions, front, frontApprovalKey, rows, now: Date.now() };
}

function homeWidgetResponse(
  { userId, organizationId }: HomeWidgetScope,
  { rows, now }: ScopeRead
): HomeWidgetResponse {
  const data = buildHomeWidgetData({ sessions: rows, userId, organizationId, now });
  return {
    ...data,
    home: buildHomeWidgetPresentation(data, now),
    refreshAt: homeWidgetRefreshAt(data, now),
    presentationTimeline: buildHomeWidgetPresentationTimeline(data, now),
  };
}

/**
 * Authorized callers only. Home details and counts use one complete read.
 * `signal` stops the upstream fetches when the caller's deadline expires.
 */
export async function buildHomeWidgetResponseForUser(
  scope: HomeWidgetScope,
  signal?: AbortSignal
): Promise<HomeWidgetResponse> {
  return homeWidgetResponse(scope, await readScope(scope, signal));
}

/**
 * The facts of one followed session that its session card shows. `row` is
 * null when the session is gone or no longer in this scope: the card must end
 * at once. A session that exists but left the active list reads as `idle`.
 */
export type GlanceableSessionCardSource = {
  sessionId: string;
  row: {
    title: string | null;
    status: string;
    statusUpdatedAt: string | null;
    scheduledAt: string | null;
    approvalKey: string | null;
  } | null;
};

export type GlanceableDelivery = {
  /** Every session in the scope: the Home widget and the data-only wakes. */
  response: HomeWidgetResponse;
  /** Only the sessions no session card follows: the aggregate Live Activity. */
  liveActivitySnapshot: GlanceableAgentsSnapshot;
  sessionCards: GlanceableSessionCardSource[];
};

function isoOrNull(value: string | null): string | null {
  const at = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

async function readSessionCards(
  scope: HomeWidgetScope,
  followed: ReadonlySet<string>,
  read: ScopeRead,
  signal: AbortSignal | undefined
): Promise<GlanceableSessionCardSource[]> {
  const listed = new Map(read.sessions.map(row => [row.id, row]));
  const unlisted = [...followed].filter(id => !listed.has(id));
  const stored =
    unlisted.length === 0
      ? []
      : await db
          .select({
            sessionId: cli_sessions_v2.session_id,
            title: cli_sessions_v2.title,
            statusUpdatedAt: cli_sessions_v2.status_updated_at,
            updatedAt: cli_sessions_v2.updated_at,
          })
          .from(cli_sessions_v2)
          .where(
            and(
              inArray(cli_sessions_v2.session_id, unlisted),
              eq(cli_sessions_v2.kilo_user_id, scope.userId),
              scope.organizationId === null
                ? isNull(cli_sessions_v2.organization_id)
                : eq(cli_sessions_v2.organization_id, scope.organizationId)
            )
          );
  const storedById = new Map(stored.map(row => [row.sessionId, row]));

  return Promise.all(
    [...followed].map(async (sessionId): Promise<GlanceableSessionCardSource> => {
      const row = listed.get(sessionId);
      if (row !== undefined) {
        const approvalKey =
          row.status !== 'permission'
            ? null
            : row === read.front
              ? read.frontApprovalKey
              : await readApprovalKey(scope, row, signal);
        return {
          sessionId,
          row: {
            title: row.title,
            status: row.status,
            statusUpdatedAt: row.statusUpdatedAt ?? null,
            scheduledAt: row.scheduledAt ?? null,
            approvalKey,
          },
        };
      }
      const kept = storedById.get(sessionId);
      if (kept === undefined) return { sessionId, row: null };
      // No open run or live connection holds it any more: the agent finished.
      return {
        sessionId,
        row: {
          title: kept.title,
          status: 'idle',
          statusUpdatedAt: isoOrNull(kept.statusUpdatedAt) ?? isoOrNull(kept.updatedAt),
          scheduledAt: null,
          approvalKey: null,
        },
      };
    })
  );
}

/**
 * Background delivery read for the notifications service. One session read
 * builds the Home response, the aggregate card counts without the followed
 * sessions (spec "Aggregate card coexistence"), and the card facts of each
 * followed session. Authorized callers only.
 */
export async function buildGlanceableDeliveryForUser(
  scope: HomeWidgetScope,
  signal?: AbortSignal
): Promise<GlanceableDelivery> {
  const [read, tokens] = await Promise.all([
    readScope(scope, signal),
    db
      .select({ sessionId: user_activity_tokens.session_id })
      .from(user_activity_tokens)
      .where(
        and(
          eq(user_activity_tokens.user_id, scope.userId),
          scope.organizationId === null
            ? isNull(user_activity_tokens.organization_id)
            : eq(user_activity_tokens.organization_id, scope.organizationId),
          eq(user_activity_tokens.kind, 'ios_session_activity'),
          isNull(user_activity_tokens.superseded_at),
          isNotNull(user_activity_tokens.session_id),
          // ActivityKit ends a card at its maximum lifetime; an older row
          // follows nothing. The notifications service deletes such rows.
          gt(
            user_activity_tokens.created_at,
            sql`now() - make_interval(secs => ${SESSION_LIVE_ACTIVITY_MAX_AGE_MS / 1000})`
          )
        )
      ),
  ]);
  const followed = new Set(tokens.flatMap(row => (row.sessionId === null ? [] : [row.sessionId])));
  const response = homeWidgetResponse(scope, read);
  if (followed.size === 0) {
    return { response, liveActivitySnapshot: response.snapshot, sessionCards: [] };
  }
  return {
    response,
    liveActivitySnapshot: buildGlanceableSnapshot({
      sessions: read.sessions.filter(row => !followed.has(row.id)),
      userId: scope.userId,
      organizationId: scope.organizationId,
      now: read.now,
    }),
    sessionCards: await readSessionCards(scope, followed, read, signal),
  };
}
