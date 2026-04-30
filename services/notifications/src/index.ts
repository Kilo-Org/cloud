import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { user_push_tokens } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { useWorkersLogger } from 'workers-tagged-logger';

import { presenceContextForConversation } from '@kilocode/event-service';
import {
  badgeBucketForConversation,
  markBadgeReadInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendInstanceLifecycleNotificationParams,
  type SendInstanceLifecycleNotificationResult,
  type ListBadgesResponse,
  type MarkBadgeReadResponse,
  type PerRecipientResult,
  type SendPushForConversationInput,
  type SendPushForConversationOutput,
} from '@kilocode/notifications';

import { authMiddleware, type AuthContext } from './auth';
import type { TicketTokenPair } from './lib/expo-push';
import { sendPushNotifications } from './lib/expo-push';
import { dispatchInstanceLifecyclePush } from './lib/instance-lifecycle-push';
import { queue } from './queue-consumer';

export { NotificationChannelDO } from './dos/NotificationChannelDO';
export type {
  InstanceLifecycleEvent,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '@kilocode/notifications';

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

  const perRecipient: PerRecipientResult[] = [];
  for (const userId of recipients) {
    const stub = deps.getRecipientDOStub(userId);
    const outcome = await stub.dispatchPush({
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
        data: {
          type: 'chat.message',
          sandboxId: input.sandboxId,
          conversationId: input.conversationId,
          messageId: input.messageId,
        },
        sound: 'default',
        priority: 'high',
      },
    });
    perRecipient.push({ userId, outcome: outcome.kind });
  }
  return { perRecipient };
}

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
    return sendPushForConversationCore(input, {
      getRecipientDOStub: (userId: string) =>
        this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)
        ) as unknown as RecipientDOStub,
    });
  }

  async sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    return dispatchInstanceLifecyclePush(params, {
      getTokens: async userId => {
        const rows = await db
          .select({ token: user_push_tokens.token })
          .from(user_push_tokens)
          .where(eq(user_push_tokens.user_id, userId));
        return rows.map(r => r.token);
      },
      deleteStaleTokens: async tokens => {
        await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, tokens));
      },
      sendPush: async messages => {
        const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
        return sendPushNotifications(messages, accessToken);
      },
      enqueueReceipts: async ticketTokenPairs => {
        const receiptMsg: ReceiptCheckMessage = { ticketTokenPairs };
        await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
      },
    });
  }
}

export default NotificationsService;
