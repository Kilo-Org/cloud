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
  markConversationReadInputSchema,
  parseBadgeBucket,
  sendInstanceLifecycleNotificationInputSchema,
  sendPushForConversationInputSchema,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type SendInstanceLifecycleNotificationParams,
  type SendInstanceLifecycleNotificationResult,
  type ListBadgesResponse,
  type MarkBadgeReadResponse,
  type MarkConversationReadInput,
  type MarkConversationReadOutput,
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
  const instanceCounts = new Map<string, number>();
  const conversations: ListBadgesResponse['conversations'] = [];
  for (const bucket of buckets) {
    const parsed = parseBadgeBucket(bucket.badgeBucket);
    if (parsed.kind === 'kiloclaw-conversation') {
      conversations.push({
        sandboxId: parsed.sandboxId,
        conversationId: parsed.conversationId,
        unreadCount: bucket.badgeCount,
      });
      instanceCounts.set(
        parsed.sandboxId,
        (instanceCounts.get(parsed.sandboxId) ?? 0) + bucket.badgeCount
      );
    } else if (parsed.kind === 'kiloclaw-instance') {
      instanceCounts.set(
        parsed.sandboxId,
        (instanceCounts.get(parsed.sandboxId) ?? 0) + bucket.badgeCount
      );
    }
  }
  const instances = Array.from(instanceCounts, ([sandboxId, unreadCount]) => ({
    sandboxId,
    unreadCount,
  }));
  const response = { instances, conversations } satisfies ListBadgesResponse;
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

export function parseSendPushForConversationRpcInput(input: unknown): SendPushForConversationInput {
  const result = sendPushForConversationInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Invalid sendPushForConversation input');
  }
  return result.data;
}

export function parseMarkConversationReadRpcInput(input: unknown): MarkConversationReadInput {
  const result = markConversationReadInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Invalid markConversationRead input');
  }
  return result.data;
}

function parseSendInstanceLifecycleNotificationRpcInput(
  input: unknown
): SendInstanceLifecycleNotificationParams {
  const result = sendInstanceLifecycleNotificationInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Invalid sendInstanceLifecycleNotification input');
  }
  return result.data;
}

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

  const results = await Promise.allSettled(
    recipients.map(async userId => {
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
      return outcome.kind;
    })
  );
  const perRecipient: PerRecipientResult[] = recipients.map((userId, index) => {
    const result = results[index];
    return {
      userId,
      outcome: result?.status === 'fulfilled' ? result.value : 'failed',
    };
  });
  return { perRecipient };
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
    return sendPushForConversationCore(parseSendPushForConversationRpcInput(input), {
      getRecipientDOStub: (userId: string) =>
        this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(userId)
        ) as unknown as RecipientDOStub,
    });
  }

  async markConversationRead(
    input: MarkConversationReadInput
  ): Promise<MarkConversationReadOutput> {
    const inputData = parseMarkConversationReadRpcInput(input);
    const stub = this.env.NOTIFICATION_CHANNEL_DO.get(
      this.env.NOTIFICATION_CHANNEL_DO.idFromName(inputData.userId)
    );
    const badgeCount = await stub.markBucketRead(
      badgeBucketForConversation(inputData.sandboxId, inputData.conversationId)
    );
    return { badgeCount };
  }

  async sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult> {
    const paramsData = parseSendInstanceLifecycleNotificationRpcInput(params);
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    return dispatchInstanceLifecyclePush(paramsData, {
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
