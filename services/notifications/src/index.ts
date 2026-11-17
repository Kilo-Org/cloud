import { timingSafeEqual } from '@kilocode/encryption';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  organization_memberships,
  user_activity_tokens,
  user_notification_preferences,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';

import {
  glanceableScopeRefreshRequestSchema,
  internalDispatchRequestSchema,
  markBadgeReadInputSchema,
  refreshGlanceableSessionsInputSchema,
  type RefreshGlanceableSessionsParams,
  type ClearBadgeBucketForUserInput,
  type ClearBadgeBucketForUserOutput,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendAgentSessionNotificationParams,
  type SendAgentSessionNotificationResult,
  type SendCloudAgentSessionNotificationParams,
  type SendCloudAgentSessionNotificationResult,
  type SendSessionReadyNotificationParams,
  type SendSessionReadyNotificationResult,
  type ListBadgesResponse,
  type MarkBadgeReadResponse,
} from '@kilocode/notifications';

import { authMiddleware, type AuthContext } from './auth';
import {
  dispatchAgentSessionNotificationPush,
  type DispatchAgentSessionNotificationPushDeps,
} from './lib/agent-session-notification-push';
import {
  dispatchCloudAgentSessionPush,
  dispatchSessionReadyPush,
  type DispatchCloudAgentSessionPushDeps,
  type UserNotificationPreferences,
} from './lib/cloud-agent-session-push';
import { dispatchInternalPushCore } from './lib/internal-dispatch-push';
import {
  NOTIFICATION_HISTORY_PRUNE_CRON,
  pruneNotificationHistory,
} from './lib/notification-history-prune';
import { queue } from './queue-consumer';

export { NotificationChannelDO } from './dos/NotificationChannelDO';

const ALLOWED_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

// ── Structured logging context ──────────────────────────────────────────
// Establishes AsyncLocalStorage context so all downstream logs (including
// tags set by the auth middleware) propagate through the request.
// Cast needed: workers-tagged-logger@1.0.0 was built against an older Hono.
app.use('*', useWorkersLogger('notifications') as unknown as MiddlewareHandler);

app.get('/', c => c.json({ ok: true }));

app.use(
  '/v1/*',
  cors({
    origin: origin => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use('/v1/*', authMiddleware);

app.get('/v1/badges', async c => {
  const userId = c.get('callerId');
  const stub = c.env.NOTIFICATION_CHANNEL_DO.get(c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId));
  const buckets = await stub.listNonZeroBuckets();
  const response = { buckets } satisfies ListBadgesResponse;
  return c.json(response);
});

app.post('/v1/badges/mark-read', async c => {
  const userId = c.get('callerId');
  const body: unknown = await c.req.json().catch(() => null);
  const parsedBody = markBadgeReadInputSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: 'badgeBucket required' }, 400);
  }
  const stub = c.env.NOTIFICATION_CHANNEL_DO.get(c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId));
  const badgeCount = await stub.markBucketRead(parsedBody.data.badgeBucket);
  const response = { badgeCount } satisfies MarkBadgeReadResponse;
  return c.json(response);
});

async function hasValidInternalSecret(c: {
  req: { header(name: string): string | undefined };
  env: Env;
}): Promise<boolean> {
  const provided = c.req.header('X-Internal-Secret');
  const expected = await c.env.INTERNAL_API_SECRET.get();
  if (!provided || !expected) return false;

  return timingSafeEqual(provided, expected);
}

// Internal service-to-service dispatch (low-balance + spend-alert +
// security-finding). Intentionally outside `/v1/*` so user-JWT auth
// middleware does not apply.
app.post('/internal/v1/dispatch', async c => {
  if (!(await hasValidInternalSecret(c))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const parsed = internalDispatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const result = await dispatchInternalPushCore(parsed.data, {
    getRecipientDOStub: (userId: string) =>
      c.env.NOTIFICATION_CHANNEL_DO.get(c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)),
    readPreferences: async userId => readPreferencesRow(db, userId),
  });
  const failedRecipients = result.perRecipient.filter(r => r.outcome === 'failed').length;
  if (failedRecipients > 0) {
    // Counts and the caller-supplied dispatch id only — never recipient ids.
    console.warn('Internal dispatch completed with failed recipients', {
      dispatchId: c.req.header('X-Dispatch-Id') ?? null,
      kind: parsed.data.kind,
      failedRecipients,
      totalRecipients: result.perRecipient.length,
    });
  }
  return c.json(result);
});

// Registering a replacement iOS activity token retires the previous live
// `ios_activity` row; the retired card is only sent its `end` by a delivery
// pass, and those are otherwise driven by agent-session transitions. The web
// router asks for one here so an orphan card the client cannot see after
// process death is dismissed at registration instead of staying stacked under
// the new card for as long as the current agent state does not change. Same
// internal-secret auth as the dispatch route; the DO owns the rate limit, so a
// refresh inside the delivery window is deferred rather than dropped.
app.post('/internal/v1/glanceable-refresh', async c => {
  if (!(await hasValidInternalSecret(c))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = glanceableScopeRefreshRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const { userId, organizationId } = parsed.data;
  const stub = c.env.NOTIFICATION_CHANNEL_DO.get(c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId));
  await stub.refreshGlanceableSnapshot({ userId, organizationId });
  return c.json({ ok: true });
});

type RecipientDOStub = {
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

/**
 * HTTP and RPC entrypoint for the notifications Worker.
 *
 * RPC callers authenticate implicitly via the binding topology: only Workers
 * explicitly bound to `notifications` with `entrypoint: "NotificationsService"`
 * can reach these methods. No shared secret is needed.
 */
export class NotificationsService extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  override async queue(batch: MessageBatch): Promise<void> {
    return queue(batch as Parameters<typeof queue>[0], this.env);
  }

  /**
   * Retention sweep for the notification history this worker writes. Any other
   * cron warns rather than running a sweep the trigger did not ask for.
   */
  async scheduled(controller: ScheduledController): Promise<void> {
    if (controller.cron !== NOTIFICATION_HISTORY_PRUNE_CRON) {
      console.warn('notifications_worker_unrecognized_cron', { cron: controller.cron });
      return;
    }
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    const { deleted, hasMore } = await pruneNotificationHistory(db);
    console.log('notification_history_prune_complete', { deleted, hasMore });
  }

  async clearBadgeBucketForUser(
    input: ClearBadgeBucketForUserInput
  ): Promise<ClearBadgeBucketForUserOutput> {
    const stub = this.env.NOTIFICATION_CHANNEL_DO.get(
      this.env.NOTIFICATION_CHANNEL_DO.idFromName(input.userId)
    );
    const badgeCount = await stub.markBucketRead(input.badgeBucket);
    return { badgeCount } satisfies ClearBadgeBucketForUserOutput;
  }

  async sendCloudAgentSessionNotification(
    params: SendCloudAgentSessionNotificationParams
  ): Promise<SendCloudAgentSessionNotificationResult> {
    return dispatchCloudAgentSessionPush(params, this.cloudAgentSessionPushDeps());
  }

  /** Refresh each affected scope without notification preferences or viewer-presence gates. */
  async refreshGlanceableSessions(params: RefreshGlanceableSessionsParams): Promise<void> {
    const { userId, cliSessionIds, approvalChangedSessionIds, cardFollowSessionIds } =
      refreshGlanceableSessionsInputSchema.parse(params);
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    // A caller that only refreshes the session card names the sessions whose
    // new content must reach a card. One indexed read decides whether any of
    // them is followed; when none is, the whole build and device wake is
    // pointless, so skip this call. The notifications refresh stays rate
    // limited per scope, which coalesces the callers that do pass the gate.
    if (cardFollowSessionIds !== undefined && cardFollowSessionIds.length > 0) {
      const followed = await db
        .select({ sessionId: user_activity_tokens.session_id })
        .from(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.user_id, userId),
            inArray(user_activity_tokens.session_id, cardFollowSessionIds),
            isNull(user_activity_tokens.superseded_at),
            inArray(user_activity_tokens.kind, ['ios_session_activity', 'android_session_ongoing'])
          )
        )
        .limit(1);
      if (followed.length === 0) return;
    }
    // Read ownership too: an absent row is personal, but a foreign row is not authorized.
    const rows = await db
      .select({
        sessionId: cli_sessions_v2.session_id,
        userId: cli_sessions_v2.kilo_user_id,
        organizationId: cli_sessions_v2.organization_id,
      })
      .from(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.session_id, cliSessionIds));
    const byId = new Map(rows.map(row => [row.sessionId, row]));
    const scopesOf = (sessionIds: readonly string[]): Set<string | null> => {
      const scopes = new Set<string | null>();
      for (const sessionId of sessionIds) {
        const row = byId.get(sessionId);
        if (!row) scopes.add(null);
        else if (row.userId === userId) scopes.add(row.organizationId);
      }
      return scopes;
    };
    const scopes = scopesOf(cliSessionIds);
    // The window exemption reaches only the scope(s) that actually moved into or
    // out of `permission`. Forwarding the caller's flag to every scope would skip
    // the rate-limit/deferral branch for scopes with no approval change — an extra
    // build and device wake, the cost this window exists to prevent.
    const approvalScopes = scopesOf(approvalChangedSessionIds ?? []);

    // Every entrypoint uses the same user DO. The snapshot route still rechecks membership.
    const stub = this.env.NOTIFICATION_CHANNEL_DO.get(
      this.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)
    );
    const results = await Promise.allSettled(
      [...scopes].map(organizationId =>
        stub.refreshGlanceableSnapshot({
          userId,
          organizationId,
          approvalChanged: approvalScopes.has(organizationId),
        })
      )
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('Glanceable aggregate delivery failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  /**
   * Agent-callable push for the `notify_user` tool. Resolves the session
   * service-side, fails closed on a preference read failure, dispatches with
   * the CLI session presence context and the per-session agent rate limit,
   * and emits the deterministic `agent_push_outcome` structured log
   * (identifiers + outcome only, never message content).
   *
   * A thrown DO/transport error propagates as a thrown RPC error so the
   * caller's dispatch marker stays `pending`; returned results are
   * terminal.
   */
  async sendAgentSessionNotification(
    params: SendAgentSessionNotificationParams
  ): Promise<SendAgentSessionNotificationResult> {
    const result = await dispatchAgentSessionNotificationPush(
      params,
      this.agentSessionNotificationPushDeps()
    );
    // Deterministic outcome observer (§4.15). Identifiers and outcome only;
    // never the user-supplied message content.
    console.log({
      event: 'agent_push_outcome',
      cliSessionId: params.cliSessionId,
      notificationId: params.notificationId,
      outcome: result.dispatched ? 'delivered' : (result.reason ?? 'unknown'),
    });
    return result;
  }

  private agentSessionNotificationPushDeps(): DispatchAgentSessionNotificationPushDeps {
    let db: ReturnType<typeof getWorkerDb> | undefined;
    const getDbForCall = () => (db ??= getWorkerDb(this.env.HYPERDRIVE.connectionString));

    return {
      getSession: async (userId, cliSessionId) => {
        const [session] = await getDbForCall()
          .select({
            title: cli_sessions_v2.title,
            organizationId: cli_sessions_v2.organization_id,
            status: cli_sessions_v2.status,
            statusUpdatedAt: cli_sessions_v2.status_updated_at,
          })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.session_id, cliSessionId),
              eq(cli_sessions_v2.kilo_user_id, userId)
            )
          )
          .limit(1);
        return session ?? null;
      },
      hasOrganizationAccess: async (userId, organizationId) => {
        const [membership] = await getDbForCall()
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, organizationId),
              eq(organization_memberships.kilo_user_id, userId)
            )
          )
          .limit(1);
        return membership !== undefined;
      },
      readPreferences: async userId => readPreferencesRow(getDbForCall(), userId),
      dispatchPush: async input => {
        const stub = this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(input.userId)
        ) as unknown as RecipientDOStub;
        return stub.dispatchPush(input);
      },
    };
  }

  async sendSessionReadyNotification(
    params: SendSessionReadyNotificationParams
  ): Promise<SendSessionReadyNotificationResult> {
    return dispatchSessionReadyPush(params, this.cloudAgentSessionPushDeps());
  }

  private cloudAgentSessionPushDeps(): DispatchCloudAgentSessionPushDeps {
    let db: ReturnType<typeof getWorkerDb> | undefined;
    const getDbForCall = () => (db ??= getWorkerDb(this.env.HYPERDRIVE.connectionString));

    return {
      getSession: async (userId, cliSessionId) => {
        const [session] = await getDbForCall()
          .select({
            title: cli_sessions_v2.title,
            organizationId: cli_sessions_v2.organization_id,
            prUrl: cli_sessions_v2.pr_url,
            status: cli_sessions_v2.status,
            statusUpdatedAt: cli_sessions_v2.status_updated_at,
          })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.session_id, cliSessionId),
              eq(cli_sessions_v2.kilo_user_id, userId)
            )
          )
          .limit(1);
        return session ?? null;
      },
      hasOrganizationAccess: async (userId, organizationId) => {
        const [membership] = await getDbForCall()
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, organizationId),
              eq(organization_memberships.kilo_user_id, userId)
            )
          )
          .limit(1);
        return membership !== undefined;
      },
      readPreferences: async userId => readPreferencesRow(getDbForCall(), userId),
      dispatchPush: async input => {
        const stub = this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(input.userId)
        ) as unknown as RecipientDOStub;
        return stub.dispatchPush(input);
      },
    };
  }
}

export default NotificationsService;

/**
 * Read the full per-category preference row. Returns `null` when the user
 * has no row yet (default-on for every category). A thrown DB error
 * propagates so each call site can choose fail-closed semantics
 * (`agent_push_enabled` swallows it to `failed`; cloud-agent-session
 * surfaces it as `dispatch_failed`).
 */
async function readPreferencesRow(
  db: ReturnType<typeof getWorkerDb>,
  userId: string
): Promise<UserNotificationPreferences | null> {
  const [row] = await db
    .select({
      agentPushEnabled: user_notification_preferences.agent_push_enabled,
      agentAttentionEnabled: user_notification_preferences.agent_attention_enabled,
      sessionStatusEnabled: user_notification_preferences.session_status_enabled,
      balanceAlertsEnabled: user_notification_preferences.balance_alerts_enabled,
      spendAlertsEnabled: user_notification_preferences.spend_alerts_enabled,
      securityFindingsEnabled: user_notification_preferences.security_findings_enabled,
    })
    .from(user_notification_preferences)
    .where(eq(user_notification_preferences.user_id, userId))
    .limit(1);
  if (!row) return null;
  return row;
}
