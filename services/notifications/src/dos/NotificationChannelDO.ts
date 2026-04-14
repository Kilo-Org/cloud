import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { channel_badge_counts, kiloclaw_instances, user_push_tokens } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import type { Event } from 'stream-chat';

import type { ExpoPushMessage, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

type PendingMessage = {
  messageId: string;
  senderId: string;
  text: string;
  notified: boolean;
  createdAt: number;
  updatedAt: string; // ISO timestamp from Stream Chat payload
};

const DEDUP_PREFIX = 'dedup:';
const MSG_PREFIX = 'msg:';
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEBOUNCE_MS = 10_000; // 10 seconds

export class NotificationChannelDO extends DurableObject<Env> {
  async processWebhook(payload: Event, webhookId: string): Promise<Response> {
    // Webhook-level dedup (prevents reprocessing the same delivery)
    const existing = await this.ctx.storage.get<number>(`${DEDUP_PREFIX}${webhookId}`);
    if (existing) {
      return Response.json({ ok: true, deduplicated: true });
    }
    await this.markWebhookSeen(webhookId);

    const messageId = payload.message?.id;
    const senderId = payload.message?.user?.id;
    const messageText = payload.message?.text ?? '';
    const messageUpdatedAt = payload.message?.updated_at ?? payload.created_at ?? '';

    if (!messageId || !senderId?.startsWith('bot-')) {
      return Response.json({ ok: true });
    }

    const msgKey = `${MSG_PREFIX}${messageId}`;
    const pendingMessage = await this.ctx.storage.get<PendingMessage>(msgKey);

    if (pendingMessage?.notified) {
      return Response.json({ ok: true });
    }

    if (pendingMessage) {
      // Only accept if this event is newer than what we have
      if (messageUpdatedAt <= pendingMessage.updatedAt) {
        return Response.json({ ok: true });
      }
      if (messageText) {
        pendingMessage.text = messageText;
      }
      pendingMessage.updatedAt = messageUpdatedAt;
      await this.ctx.storage.put(msgKey, pendingMessage);
      await this.scheduleAlarm(DEBOUNCE_MS);
    } else {
      // First event for this message (could be message.new or a late message.updated)
      const pending: PendingMessage = {
        messageId,
        senderId,
        text: messageText,
        notified: false,
        createdAt: Date.now(),
        updatedAt: messageUpdatedAt,
      };
      await this.ctx.storage.put(msgKey, pending);
      await this.scheduleAlarm(DEBOUNCE_MS);
    }

    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    // Prune expired dedup entries
    const dedupEntries = await this.ctx.storage.list<number>({ prefix: DEDUP_PREFIX });
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, timestamp] of dedupEntries) {
      if (now - timestamp > DEDUP_TTL_MS) {
        expired.push(key);
      }
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired);
    }

    // Process pending messages that have debounced
    const pendingEntries = await this.ctx.storage.list<PendingMessage>({ prefix: MSG_PREFIX });
    for (const [key, msg] of pendingEntries) {
      if (msg.notified) {
        // Clean up old notified messages
        if (now - msg.createdAt > DEDUP_TTL_MS) {
          await this.ctx.storage.delete(key);
        }
        continue;
      }

      if (!msg.text) {
        // No text — nothing to notify about, discard
        await this.ctx.storage.delete(key);
        continue;
      }

      await this.sendNotification(msg);
      msg.notified = true;
      await this.ctx.storage.put(key, msg);
    }
  }

  private async sendNotification(msg: PendingMessage): Promise<void> {
    const sandboxId = msg.senderId.slice(4);
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

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
      return;
    }

    // Increment the badge count for this channel and return the new total across all channels.
    // Done before the token guard so unread state is always persisted even if the user
    // temporarily has no registered push tokens (e.g. between reinstalls).
    // Uses UPSERT so the row is created on first notification for this channel.
    await db
      .insert(channel_badge_counts)
      .values({ user_id: instance.user_id, channel_id: sandboxId, badge_count: 1 })
      .onConflictDoUpdate({
        target: [channel_badge_counts.user_id, channel_badge_counts.channel_id],
        set: { badge_count: sql`${channel_badge_counts.badge_count} + 1` },
      });

    const [totals] = await db
      .select({ total: sum(channel_badge_counts.badge_count) })
      .from(channel_badge_counts)
      .where(eq(channel_badge_counts.user_id, instance.user_id));

    const badgeCount = Number(totals?.total ?? 0);

    const tokens = await db
      .select({ token: user_push_tokens.token })
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, instance.user_id));

    if (tokens.length === 0) {
      return;
    }

    const truncatedMessage = msg.text.length > 100 ? msg.text.slice(0, 97) + '...' : msg.text;

    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      title: instance.name ?? 'KiloClaw',
      body: truncatedMessage,
      // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
      data: { type: 'chat', instanceId: sandboxId },
      badge: badgeCount,
      sound: 'default' as const,
      priority: 'high' as const,
    }));

    const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
    const { ticketTokenPairs, staleTokens } = await sendPushNotifications(messages, accessToken);

    if (staleTokens.length > 0) {
      await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
    }

    if (ticketTokenPairs.length > 0) {
      const receiptMsg: ReceiptCheckMessage = { ticketTokenPairs };
      await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
    }
  }

  private async markWebhookSeen(webhookId: string): Promise<void> {
    await this.ctx.storage.put(`${DEDUP_PREFIX}${webhookId}`, Date.now());
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    // Always reset the alarm to the new debounce window
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }
}

export function getNotificationChannelDO(
  env: Env,
  channelId: string
): DurableObjectStub<NotificationChannelDO> {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(channelId);
  return env.NOTIFICATION_CHANNEL_DO.get(id) as DurableObjectStub<NotificationChannelDO>;
}
