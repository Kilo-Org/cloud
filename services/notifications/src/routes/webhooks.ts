import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Event } from 'stream-chat';

import { getNotificationChannelDO } from '../dos/NotificationChannelDO';

const webhooks = new Hono<{ Bindings: Env }>();

function verifyWebhookSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;

  const expectedSignature = createHmac('sha256', secret).update(body).digest('hex');

  if (signature.length !== expectedSignature.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

webhooks.post('/stream-chat', async c => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-signature') ?? null;
  const webhookId = c.req.header('x-webhook-id');

  const secret = await c.env.STREAM_CHAT_API_SECRET.get();
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(rawBody) as Event;

  // Only handle new messages
  if (payload.type !== 'message.new') {
    return c.json({ ok: true });
  }

  const channelId = payload.channel_id;
  if (!channelId || !webhookId) {
    return c.json({ ok: true });
  }

  // Forward to the channel's Durable Object for dedup + delivery
  const stub = getNotificationChannelDO(c.env, channelId);
  return stub.processWebhook(payload, webhookId);
});

export { webhooks };
