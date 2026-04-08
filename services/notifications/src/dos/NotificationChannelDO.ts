import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_instances, user_push_tokens } from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Event } from 'stream-chat';

import type { ExpoPushMessage, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

const DEDUP_PREFIX = 'dedup:';
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

export class NotificationChannelDO extends DurableObject<Env> {
  async processWebhook(payload: Event, webhookId: string): Promise<Response> {
    // Dedup: skip if we've seen this webhook ID recently
    const existing = await this.ctx.storage.get<number>(`${DEDUP_PREFIX}${webhookId}`);
    if (existing) {
      return Response.json({ ok: true, deduplicated: true });
    }

    const senderId = payload.message?.user?.id;
    const messageText = payload.message?.text;

    if (!senderId?.startsWith('bot-') || !messageText) {
      return Response.json({ ok: true });
    }

    // Extract sandbox ID from bot user ID: "bot-{sandboxId}" → sandboxId
    const sandboxId = senderId.slice(4);

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    // Look up the active instance for this sandbox
    const [instance] = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        name: kiloclaw_instances.name,
      })
      .from(kiloclaw_instances)
      .where(
        and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
      )
      .limit(1);

    if (!instance) {
      return Response.json({ ok: true });
    }

    // Fetch user's push tokens
    const tokens = await db
      .select({ token: user_push_tokens.token })
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, instance.user_id));

    if (tokens.length === 0) {
      await this.markSeen(webhookId);
      return Response.json({ ok: true });
    }

    const truncatedMessage =
      messageText.length > 100 ? messageText.slice(0, 97) + '...' : messageText;

    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      title: instance.name ?? 'Kilo',
      body: truncatedMessage,
      // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
      data: { type: 'chat', instanceId: instance.id },
      sound: 'default' as const,
      priority: 'high' as const,
    }));

    // Send push notifications
    const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
    const { ticketTokenPairs, staleTokens } = await sendPushNotifications(messages, accessToken);

    // Immediately clean up tokens that are known stale
    if (staleTokens.length > 0) {
      await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
      console.log(`Cleaned up ${staleTokens.length} stale push token(s)`);
    }

    // Enqueue delayed receipt check if we have tickets to follow up on
    if (ticketTokenPairs.length > 0) {
      const message: ReceiptCheckMessage = { ticketTokenPairs };
      await this.env.RECEIPTS_QUEUE.send(message, { delaySeconds: 900 });
    }

    // Mark webhook as processed
    await this.markSeen(webhookId);

    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    // Prune expired dedup entries
    const all = await this.ctx.storage.list<number>({ prefix: DEDUP_PREFIX });
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, timestamp] of all) {
      if (now - timestamp > DEDUP_TTL_MS) {
        expired.push(key);
      }
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired);
    }
  }

  private async markSeen(webhookId: string): Promise<void> {
    await this.ctx.storage.put(`${DEDUP_PREFIX}${webhookId}`, Date.now());
    // Ensure a cleanup alarm is scheduled
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + DEDUP_TTL_MS);
    }
  }
}

export function getNotificationChannelDO(
  env: Env,
  channelId: string
): DurableObjectStub<NotificationChannelDO> {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(channelId);
  return env.NOTIFICATION_CHANNEL_DO.get(id) as DurableObjectStub<NotificationChannelDO>;
}
