import { timingSafeEqual } from 'node:crypto';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  organization_memberships,
  user_activity_tokens,
  user_notification_preferences,
  user_push_tokens,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';

import { presenceContextForConversation } from '@kilocode/event-service';
import {
  badgeBucketForConversation,
  internalDispatchRequestSchema,
  markBadgeReadInputSchema,
  pushDataSchema,
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
  type SendInstanceLifecycleNotificationParams,
  type SendInstanceLifecycleNotificationResult,
  type ListBadgesResponse,
  type MarkBadgeReadResponse,
  type PerRecipientResult,
  type SendPushForConversationInput,
  type SendPushForConversationOutput,
} from '@kilocode/notifications';

import { authMiddleware, type AuthContext } from './auth';
import {
  dispatchAgentSessionNotificationPush,
  type DispatchAgentSessionNotificationPushDeps,
} from './lib/agent-session-notification-push';
import { sendLiveActivityApns, type ApnsCredentials } from './lib/apns-live-activity';
import {
  dispatchCloudAgentSessionPush,
  dispatchSessionReadyPush,
  type DispatchCloudAgentSessionPushDeps,
  type UserNotificationPreferences,
} from './lib/cloud-agent-session-push';
import type { TicketTokenPair } from './lib/expo-push';
import { sendPushNotifications } from './lib/expo-push';
import {
  deliverGlanceableSnapshot,
  type GlanceableDeliveryDeps,
  type IosActivityToken,
} from './lib/glanceable-delivery';
import { dispatchInstanceLifecyclePush } from './lib/instance-lifecycle-push';
import { dispatchInternalPushCore } from './lib/internal-dispatch-push';
import {
  dispatchScheduledActionPush,
  type SendScheduledActionNoticeParams,
  type SendScheduledActionNoticeResult,
} from './lib/scheduled-action-push';
import { queue } from './queue-consumer';

export { NotificationChannelDO } from './dos/NotificationChannelDO';
export type {
  InstanceLifecycleEvent,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';
export type {
  ScheduledActionEvent,
  SendScheduledActionNoticeParams,
  SendScheduledActionNoticeResult,
} from './lib/scheduled-action-push';

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

  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (providedBytes.byteLength !== expectedBytes.byteLength) {
    // timingSafeEqual requires equal lengths; self-compare so a length
    // mismatch is not observably faster to reject than a value mismatch.
    timingSafeEqual(providedBytes, providedBytes);
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}

// Internal service-to-service dispatch (low-balance + security-finding).
// Intentionally outside `/v1/*` so user-JWT auth middleware does not apply.
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
      c.env.NOTIFICATION_CHANNEL_DO.get(
        c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)
      ) as unknown as RecipientDOStub,
    readPreferences: async userId => readPreferencesRow(db, userId),
  });
  return c.json(result);
});

type RecipientDOStub = {
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

/** Pure core for unit testability. */
export async function sendPushForConversationCore(
  input: SendPushForConversationInput,
  deps: {
    getRecipientDOStub: (userId: string) => RecipientDOStub;
    /**
     * Read the per-recipient notification preferences. Throw = fail-closed
     * (suppress the recipient). `null` = successful read with no row →
     * default-on for every category.
     */
    readPreferences: (userId: string) => Promise<UserNotificationPreferences | null>;
  }
): Promise<SendPushForConversationOutput> {
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const id of input.recipientUserIds) {
    if (id === input.senderUserId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    recipients.push(id);
  }

  const results = await Promise.allSettled(
    recipients.map(async userId => {
      // Per-recipient chat preference gate. Fail-closed: a read throw
      // suppresses the recipient. `null` row is default-on.
      let enabled: boolean;
      try {
        const prefs = await deps.readPreferences(userId);
        enabled = (prefs ?? null)?.chatMessagesEnabled ?? true;
      } catch {
        return 'failed' as const;
      }
      if (!enabled) {
        return 'suppressed_preference' as const;
      }

      const stub = deps.getRecipientDOStub(userId);
      const dispatchInput = {
        userId,
        presenceContext: presenceContextForConversation(input.sandboxId, input.conversationId),
        idempotencyKey: `chat:${input.messageId}:${userId}`,
        badge: {
          badgeBucket: badgeBucketForConversation(input.sandboxId, input.conversationId),
          delta: 1,
        },
        push: {
          title: input.title,
          body: input.bodyPreview,
          ...(input.i18nKey !== undefined && {
            i18nKey: input.i18nKey,
            i18nParams: input.i18nParams,
          }),
          data: {
            type: 'chat.message',
            sandboxId: input.sandboxId,
            conversationId: input.conversationId,
            messageId: input.messageId,
          },
          sound: 'default',
          priority: 'high',
        },
      } satisfies DispatchPushInput;
      const outcome = await stub.dispatchPush(dispatchInput);
      // The old conversation RPC never passes a rate limit, but narrow the
      // DO outcome to the legacy recipient enum anyway (§9.6: do not widen
      // the existing RPC with `suppressed_rate_limit`).
      return outcome.kind === 'suppressed_rate_limit' ? 'failed' : outcome.kind;
    })
  );
  const perRecipient: PerRecipientResult[] = recipients.map((userId, index) => {
    const result = results[index];
    return {
      userId,
      outcome: result?.status === 'fulfilled' ? result.value : 'failed',
    };
  });
  return { perRecipient } satisfies SendPushForConversationOutput;
}

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

  async sendPushForConversation(
    input: SendPushForConversationInput
  ): Promise<SendPushForConversationOutput> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    return sendPushForConversationCore(input, {
      getRecipientDOStub: (userId: string) =>
        this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)
        ) as unknown as RecipientDOStub,
      readPreferences: async userId => readPreferencesRow(db, userId),
    });
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

  async sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    return dispatchInstanceLifecyclePush(params, {
      readPreference: async userId => {
        const [row] = await db
          .select({ enabled: user_notification_preferences.kiloclaw_activity_enabled })
          .from(user_notification_preferences)
          .where(eq(user_notification_preferences.user_id, userId))
          .limit(1);
        return row?.enabled ?? null;
      },
      getTokens: async userId => {
        const rows = await db
          .select({ token: user_push_tokens.token, locale: user_push_tokens.locale })
          .from(user_push_tokens)
          .where(eq(user_push_tokens.user_id, userId));
        return rows.map(r => ({ token: r.token, locale: r.locale }));
      },
      deleteStaleTokens: async tokens => {
        await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, tokens));
      },
      sendPush: async messages => {
        const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
        return sendPushNotifications(messages, accessToken);
      },
      enqueueReceipts: async ticketTokenPairs => {
        const receiptMsg = { ticketTokenPairs } satisfies ReceiptCheckMessage;
        await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
      },
    });
  }

  async sendCloudAgentSessionNotification(
    params: SendCloudAgentSessionNotificationParams
  ): Promise<SendCloudAgentSessionNotificationResult> {
    const deps = this.cloudAgentSessionPushDeps();
    const result = await dispatchCloudAgentSessionPush(params, deps);
    // Best-effort aggregate glanceable delivery (§psh). Runs after the push
    // result is terminal so a failure here never changes the RPC outcome.
    this.ctx.waitUntil(
      this.deliverGlanceableAfterSessionPush(params.userId, params.cliSessionId, deps.getSession)
    );
    return result;
  }

  /**
   * Resolve the session's organization (null means personal) and deliver the
   * fresh glanceable snapshot to iOS activity tokens and Android Expo tokens.
   * A session whose row cannot be resolved skips delivery (there is nothing to
   * scope the snapshot to). All failures are best-effort and logged without
   * device tokens or private content.
   */
  private async deliverGlanceableAfterSessionPush(
    userId: string,
    cliSessionId: string,
    getSession: DispatchCloudAgentSessionPushDeps['getSession']
  ): Promise<void> {
    try {
      const session = await getSession(userId, cliSessionId);
      if (!session) {
        return;
      }
      await deliverGlanceableSnapshot(
        { userId, organizationId: session.organizationId },
        this.glanceableDeliveryDeps()
      );
    } catch (error) {
      console.warn('Glanceable aggregate delivery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private glanceableDeliveryDeps(): GlanceableDeliveryDeps {
    let db: ReturnType<typeof getWorkerDb> | undefined;
    const getDbForCall = () => (db ??= getWorkerDb(this.env.HYPERDRIVE.connectionString));

    return {
      buildSnapshot: async (userId, organizationId) => {
        const baseUrl = this.env.KILO_WEB_API_BASE_URL;
        if (!baseUrl) {
          console.warn('KILO_WEB_API_BASE_URL missing; skipping glanceable aggregate delivery');
          return null;
        }
        let internalApiSecret: string | undefined;
        try {
          internalApiSecret = await this.env.INTERNAL_API_SECRET.get();
        } catch {
          internalApiSecret = undefined;
        }
        if (!internalApiSecret) {
          console.warn('INTERNAL_API_SECRET missing; skipping glanceable aggregate delivery');
          return null;
        }

        const response = await fetch(`${baseUrl}/api/internal/glanceable-agents-snapshot`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-secret': internalApiSecret,
          },
          body: JSON.stringify({ userId, organizationId }),
        });
        if (!response.ok) {
          console.warn('Glanceable snapshot route failed', { status: response.status });
          return null;
        }
        const raw: unknown = await response.json().catch(() => null);
        const candidate = {
          type: 'active_agents_glanceable',
          ...(typeof raw === 'object' && raw !== null ? raw : {}),
        };
        const parsed = pushDataSchema.safeParse(candidate);
        if (!parsed.success || parsed.data.type !== 'active_agents_glanceable') {
          console.warn('Glanceable snapshot route returned an invalid snapshot');
          return null;
        }
        return parsed.data;
      },
      listIosActivityTokens: async (userId, organizationId) => {
        const orgPredicate =
          organizationId === null
            ? isNull(user_activity_tokens.organization_id)
            : eq(user_activity_tokens.organization_id, organizationId);
        const rows = await getDbForCall()
          .select({ token: user_activity_tokens.token, kind: user_activity_tokens.kind })
          .from(user_activity_tokens)
          .where(
            and(
              eq(user_activity_tokens.user_id, userId),
              orgPredicate,
              inArray(user_activity_tokens.kind, ['ios_activity', 'ios_push_to_start'])
            )
          );
        return rows.map(row => ({
          token: row.token,
          kind: row.kind as IosActivityToken['kind'],
        }));
      },
      sendIosLiveActivity: async (tokens, contentState) => {
        const credentials = await this.readApnsCredentials();
        if (credentials === null) {
          return;
        }
        const result = await sendLiveActivityApns({
          credentials,
          tokens,
          contentState,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        if (result.failed > 0) {
          console.warn('Some Live Activity APNs sends failed', {
            attempted: result.attempted,
            failed: result.failed,
          });
        }
      },
      listAndroidExpoTokens: async userId => {
        const rows = await getDbForCall()
          .select({ token: user_push_tokens.token, locale: user_push_tokens.locale })
          .from(user_push_tokens)
          .where(
            and(eq(user_push_tokens.user_id, userId), isNotNull(user_push_tokens.app_version))
          );
        return rows.map(row => ({ token: row.token, locale: row.locale }));
      },
      hasAndroidOngoingToken: async (userId, organizationId) => {
        const orgPredicate =
          organizationId === null
            ? isNull(user_activity_tokens.organization_id)
            : eq(user_activity_tokens.organization_id, organizationId);
        const [row] = await getDbForCall()
          .select({ id: user_activity_tokens.id })
          .from(user_activity_tokens)
          .where(
            and(
              eq(user_activity_tokens.user_id, userId),
              orgPredicate,
              eq(user_activity_tokens.kind, 'android_ongoing')
            )
          )
          .limit(1);
        return row !== undefined;
      },
      sendAndroidPush: async messages => {
        const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
        await sendPushNotifications(messages, accessToken);
      },
    };
  }

  private async readApnsCredentials(): Promise<ApnsCredentials | null> {
    const { APNS_TEAM_ID: teamId, APNS_KEY_ID: keyId, APNS_TOPIC: topic } = this.env;
    const privateKeyBinding = this.env.APNS_PRIVATE_KEY;
    if (!teamId || !keyId || !topic || !privateKeyBinding) {
      console.warn('APNs Live Activity credentials missing; skipping Live Activity delivery');
      return null;
    }
    let privateKeyPem: string;
    try {
      privateKeyPem = await privateKeyBinding.get();
    } catch {
      console.warn('APNs Live Activity private key read failed; skipping Live Activity delivery');
      return null;
    }
    if (!privateKeyPem) {
      console.warn('APNs Live Activity private key empty; skipping Live Activity delivery');
      return null;
    }
    return { teamId, keyId, topic, privateKeyPem };
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

  async sendScheduledActionNotice(
    params: SendScheduledActionNoticeParams
  ): Promise<SendScheduledActionNoticeResult> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    return dispatchScheduledActionPush(params, {
      readPreference: async userId => {
        const [row] = await db
          .select({ enabled: user_notification_preferences.kiloclaw_activity_enabled })
          .from(user_notification_preferences)
          .where(eq(user_notification_preferences.user_id, userId))
          .limit(1);
        return row?.enabled ?? null;
      },
      getTokens: async userId => {
        const rows = await db
          .select({ token: user_push_tokens.token, locale: user_push_tokens.locale })
          .from(user_push_tokens)
          .where(eq(user_push_tokens.user_id, userId));
        return rows.map(r => ({ token: r.token, locale: r.locale }));
      },
      deleteStaleTokens: async tokens => {
        await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, tokens));
      },
      sendPush: async messages => {
        const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
        return sendPushNotifications(messages, accessToken);
      },
      enqueueReceipts: async ticketTokenPairs => {
        const receiptMsg = { ticketTokenPairs } satisfies ReceiptCheckMessage;
        await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
      },
    });
  }
}

export default NotificationsService;

/**
 * Read the full per-category preference row. Returns `null` when the user
 * has no row yet (default-on for every category). A thrown DB error
 * propagates so each call site can choose fail-closed semantics
 * (`agent_push_enabled` swallows it to `failed`; chat suppresses the
 * recipient; lifecycle/scheduled return the zero-count shape with
 * `suppressedByPreference: true`; cloud-agent-session surfaces it as
 * `dispatch_failed`).
 */
async function readPreferencesRow(
  db: ReturnType<typeof getWorkerDb>,
  userId: string
): Promise<UserNotificationPreferences | null> {
  const [row] = await db
    .select({
      agentPushEnabled: user_notification_preferences.agent_push_enabled,
      chatMessagesEnabled: user_notification_preferences.chat_messages_enabled,
      agentAttentionEnabled: user_notification_preferences.agent_attention_enabled,
      sessionStatusEnabled: user_notification_preferences.session_status_enabled,
      kiloclawActivityEnabled: user_notification_preferences.kiloclaw_activity_enabled,
      balanceAlertsEnabled: user_notification_preferences.balance_alerts_enabled,
      securityFindingsEnabled: user_notification_preferences.security_findings_enabled,
    })
    .from(user_notification_preferences)
    .where(eq(user_notification_preferences.user_id, userId))
    .limit(1);
  if (!row) return null;
  return row;
}
