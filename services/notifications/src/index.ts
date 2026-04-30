import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { presenceContextForConversation } from '@kilocode/event-service';
import {
  badgeBucketForConversation,
  type DispatchPushInput,
  type DispatchPushOutcome,
  type PerRecipientResult,
  type SendPushForConversationInput,
  type SendPushForConversationOutput,
} from '@kilocode/notifications';

import { authMiddleware, type AuthContext } from './auth';
import { queue } from './queue-consumer';

export { NotificationChannelDO } from './dos/NotificationChannelDO';

const ALLOWED_ORIGINS = ['https://kilo.ai', 'https://app.kilo.ai', 'http://localhost:3000'];

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
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
  return c.json({ buckets });
});

app.post('/v1/badges/mark-read', async c => {
  const userId = c.get('callerId');
  const body = await c.req.json<{ badgeBucket?: string }>().catch(() => null);
  if (!body?.badgeBucket) {
    return c.json({ error: 'badgeBucket required' }, 400);
  }
  const stub = c.env.NOTIFICATION_CHANNEL_DO.get(c.env.NOTIFICATION_CHANNEL_DO.idFromName(userId));
  const badgeCount = await stub.markBucketRead(body.badgeBucket);
  return c.json({ badgeCount });
});

type RecipientDOStub = {
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
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
}

export default NotificationsService;
