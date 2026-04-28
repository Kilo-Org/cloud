import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';

import {
  presenceContextForConversation,
  type PerRecipientResult,
  type SendPushForConversationInput,
  type SendPushForConversationOutput,
} from '@kilocode/notifications';

import type { NotificationChannelDO, DispatchPushInput } from './dos/NotificationChannelDO';
import { queue } from './queue-consumer';
import { webhooks } from './routes/webhooks';

export { NotificationChannelDO } from './dos/NotificationChannelDO';

const app = new Hono<{ Bindings: Env }>();

app.route('/webhooks', webhooks);

app.get('/', c => c.json({ ok: true }));

export type SendPushDeps = {
  getConversationDOStub: (
    conversationId: string
  ) => Pick<DurableObjectStub<NotificationChannelDO>, 'dispatchPush'>;
};

/**
 * Core implementation of sendPushForConversation, extracted for unit testability.
 * The WorkerEntrypoint method delegates here with real dependencies.
 */
export async function sendPushForConversationCore(
  input: SendPushForConversationInput,
  deps: SendPushDeps
): Promise<SendPushForConversationOutput> {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const id of input.recipientUserIds) {
    if (id === input.senderUserId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    recipients.push(id);
  }

  const perRecipient: PerRecipientResult[] = [];
  for (const userId of recipients) {
    const stub = deps.getConversationDOStub(input.conversationId);
    const dispatchInput: DispatchPushInput = {
      userId,
      presenceContext: presenceContextForConversation(input.conversationId),
      idempotencyKey: `chat:${input.messageId}:${userId}`,
      badge: { badgeBucket: input.conversationId, delta: 1 },
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
    };
    const outcome = await stub.dispatchPush(dispatchInput);
    perRecipient.push({ userId, outcome: outcome.kind });
  }
  return { perRecipient };
}

export default class NotificationsService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  override async queue(batch: MessageBatch): Promise<void> {
    return queue(batch as Parameters<typeof queue>[0], this.env);
  }

  async sendPushForConversation(
    input: SendPushForConversationInput
  ): Promise<SendPushForConversationOutput> {
    return sendPushForConversationCore(input, {
      getConversationDOStub: (conversationId: string) =>
        this.env.NOTIFICATION_CHANNEL_DO.get(
          this.env.NOTIFICATION_CHANNEL_DO.idFromName(conversationId)
        ),
    });
  }
}
