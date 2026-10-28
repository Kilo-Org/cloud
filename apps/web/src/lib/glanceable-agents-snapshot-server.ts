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
import {
  cli_sessions_v2,
  github_branch_pull_requests,
  user_activity_tokens,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { SESSION_LIVE_ACTIVITY_MAX_AGE_MS } from '@kilocode/notifications';
import {
  sessionLiveSummarySchema,
  type SessionLiveSummary,
} from '@kilocode/session-ingest-contracts';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { type ActiveSession, listActiveSessions } from '@/lib/active-sessions-list';
import { readCloudAgentWidgetApprovalKey } from '@/lib/cloud-agent-next/cloud-agent-client';
import { sessionPrJoinPredicate } from '@/routers/cli-sessions-v2-router';

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
 * SHA-256 binding of the one approvable permission and its command, both null
 * on any failure. The cloud session lookup is scoped to the same user and
 * organization as the counts, and the Worker re-checks that scope before
 * reading the Session DO's stored pending set (no sandbox wake). Any failure
 * drops only the identity: counts and titles stay valid and nothing is
 * fabricated. Logs carry no session, permission or user ids.
 */
async function readApproval(
  scope: HomeWidgetScope,
  front: ActiveSession,
  signal: AbortSignal | undefined
): Promise<{ approvalKey: string | null; command: string | null }> {
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
    if (!row?.cloudAgentSessionId) return { approvalKey: null, command: null };
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
    return { approvalKey: null, command: null };
  }
}

type ScopeRead = {
  sessions: ActiveSession[];
  front: ActiveSession | null;
  frontApproval: { approvalKey: string | null; command: string | null };
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
  const frontApproval =
    front === null
      ? { approvalKey: null, command: null }
      : await readApproval({ userId, organizationId }, front, signal);
  const rows: HomeWidgetSessionRow[] =
    frontApproval.approvalKey === null
      ? sessions
      : sessions.map(row =>
          row === front ? { ...row, approvalKey: frontApproval.approvalKey } : row
        );
  return { sessions, front, frontApproval, rows, now: Date.now() };
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
    /** The stored per-session summary, parsed; null when absent or invalid. */
    summary: SessionLiveSummary | null;
    /** The pending request's command, on a `permission` status only. */
    permissionCommand: string | null;
    lastActivityAt: string | null;
    costMicrodollars: number | null;
    startedAt: string | null;
    prOpened: boolean;
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

/**
 * The pull request states the session card reports as "Pull request opened".
 * `unknown` is a link GitHub verified whose state the webhook has not synced
 * yet: the session just opened it.
 */
const LIVE_PR_STATES = new Set(['open', 'draft', 'unknown']);

/**
 * True when the session's pull request is worth telling the user about: a
 * link GitHub verified for this session (the session list's own rule for
 * `associatedPr`), whose pull request is still open or a draft, or not yet
 * synced. A merged or closed pull request, and a stored link nobody verified,
 * do not count.
 */
export function isSessionCardPrOpened(pr: { verified: boolean; state: string | null }): boolean {
  return pr.verified && LIVE_PR_STATES.has(pr.state ?? 'unknown');
}

function liveSummaryOrNull(value: unknown): SessionLiveSummary | null {
  const parsed = sessionLiveSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function readSessionCards(
  scope: HomeWidgetScope,
  followed: ReadonlySet<string>,
  read: ScopeRead,
  signal: AbortSignal | undefined
): Promise<GlanceableSessionCardSource[]> {
  const ids = [...followed];
  const listed = new Map(read.sessions.map(row => [row.id, row]));
  const stored =
    ids.length === 0
      ? []
      : await db
          .select({
            sessionId: cli_sessions_v2.session_id,
            title: cli_sessions_v2.title,
            statusUpdatedAt: cli_sessions_v2.status_updated_at,
            updatedAt: cli_sessions_v2.updated_at,
            summary: cli_sessions_v2.live_summary,
            lastActivityAt: cli_sessions_v2.last_activity_at,
            costMicrodollars: cli_sessions_v2.total_cost_microdollars,
            createdAt: cli_sessions_v2.created_at,
            prVerifiedAt: cli_sessions_v2.pr_link_verified_at,
            // Null when no verified link joins a cache row, or the cache has
            // not synced the pull request yet.
            prState: github_branch_pull_requests.pr_state,
          })
          .from(cli_sessions_v2)
          .leftJoin(github_branch_pull_requests, sessionPrJoinPredicate)
          .where(
            and(
              inArray(cli_sessions_v2.session_id, ids),
              eq(cli_sessions_v2.kilo_user_id, scope.userId),
              scope.organizationId === null
                ? isNull(cli_sessions_v2.organization_id)
                : eq(cli_sessions_v2.organization_id, scope.organizationId)
            )
          );
  const storedById = new Map(stored.map(row => [row.sessionId, row]));

  return Promise.all(
    ids.map(async (sessionId): Promise<GlanceableSessionCardSource> => {
      const row = listed.get(sessionId);
      const kept = storedById.get(sessionId);
      if (row === undefined && kept === undefined) return { sessionId, row: null };
      const summary = liveSummaryOrNull(kept?.summary);
      const lastActivityAt = isoOrNull(row?.lastActivityAt ?? kept?.lastActivityAt ?? null);
      const costMicrodollars = row?.totalCostMicrodollars ?? kept?.costMicrodollars ?? null;
      const startedAt = isoOrNull(row?.createdAt ?? kept?.createdAt ?? null);
      // A listed row's `associatedPr` is present only for a verified link.
      const prOpened =
        row?.associatedPr === undefined
          ? isSessionCardPrOpened({
              verified: (kept?.prVerifiedAt ?? null) !== null,
              state: kept?.prState ?? null,
            })
          : isSessionCardPrOpened({ verified: true, state: row.associatedPr.state });
      if (row === undefined) {
        // No open run or live connection holds it any more: the agent finished.
        return {
          sessionId,
          row: {
            title: kept?.title ?? null,
            status: 'idle',
            statusUpdatedAt:
              isoOrNull(kept?.statusUpdatedAt ?? null) ?? isoOrNull(kept?.updatedAt ?? null),
            scheduledAt: null,
            approvalKey: null,
            summary,
            permissionCommand: null,
            lastActivityAt,
            costMicrodollars,
            startedAt,
            prOpened,
          },
        };
      }
      // The approval identity is read only on a waiting permission and the
      // command comes from that same request the key binds.
      const approval =
        row.status !== 'permission'
          ? { approvalKey: null, command: null }
          : row === read.front
            ? read.frontApproval
            : await readApproval(scope, row, signal);
      return {
        sessionId,
        row: {
          title: row.title,
          status: row.status,
          statusUpdatedAt:
            isoOrNull(row.statusUpdatedAt ?? null) ?? isoOrNull(kept?.statusUpdatedAt ?? null),
          scheduledAt: row.scheduledAt ?? null,
          approvalKey: approval.approvalKey,
          summary,
          permissionCommand: approval.command,
          lastActivityAt,
          costMicrodollars,
          startedAt,
          prOpened,
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
          isNull(user_activity_tokens.superseded_at),
          isNotNull(user_activity_tokens.session_id),
          or(
            // ActivityKit ends a card at its maximum lifetime; an older row
            // follows nothing. The notifications service deletes such rows.
            and(
              eq(user_activity_tokens.kind, 'ios_session_activity'),
              gt(
                user_activity_tokens.created_at,
                sql`now() - make_interval(secs => ${SESSION_LIVE_ACTIVITY_MAX_AGE_MS / 1000})`
              )
            ),
            // An Android follow has no system time limit; it lasts until the
            // user unfollows or dismisses the notification, or the card ends.
            eq(user_activity_tokens.kind, 'android_session_ongoing')
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
