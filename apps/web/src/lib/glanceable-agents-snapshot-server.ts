import 'server-only';
import {
  buildHomeWidgetData,
  buildHomeWidgetPresentation,
  buildHomeWidgetPresentationTimeline,
  homeWidgetRefreshAt,
  type HomeWidgetResponse,
  type HomeWidgetSessionRow,
} from '@kilocode/app-shared/home-widget';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, isNull } from 'drizzle-orm';

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
  front: ActiveSession
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
    return await readCloudAgentWidgetApprovalKey({
      ...scope,
      kiloSessionId: front.id,
      cloudAgentSessionId: row.cloudAgentSessionId,
    });
  } catch (error) {
    console.warn(
      '[home-widget] approval identity unavailable:',
      error instanceof Error ? error.name : 'unknown'
    );
    return null;
  }
}

/** Authorized callers only. Home details and counts use one complete read. */
export async function buildHomeWidgetResponseForUser({
  userId,
  organizationId,
}: HomeWidgetScope): Promise<HomeWidgetResponse> {
  const { sessions } = await listActiveSessions({
    userId,
    organizationId,
    includeCloudAgentSessions: true,
    requireCompleteSnapshot: true,
  });
  const front = pickFrontPermissionRow(sessions);
  const approvalKey =
    front === null ? null : await readApprovalKey({ userId, organizationId }, front);
  const rows: HomeWidgetSessionRow[] =
    approvalKey === null
      ? sessions
      : sessions.map(row => (row === front ? { ...row, approvalKey } : row));
  const now = Date.now();
  const data = buildHomeWidgetData({ sessions: rows, userId, organizationId, now });
  return {
    ...data,
    home: buildHomeWidgetPresentation(data, now),
    refreshAt: homeWidgetRefreshAt(data, now),
    presentationTimeline: buildHomeWidgetPresentationTimeline(data, now),
  };
}
