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

type PendingMessage = {
  messageId: string;
  senderId: string;
  text: string;
  notified: boolean;
  createdAt: number;
};

const DEDUP_PREFIX = 'dedup:';
const MSG_PREFIX = 'msg:';
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEBOUNCE_MS = 5_000; // 5 seconds

export class NotificationChannelDO extends DurableObject<Env> {
  async processWebhook(payload: Event, webhookId: string): Promise<Response> {
    console.log(`[DEBUG] DO received: type=${payload.type}, webhookId=${webhookId}`);

    // Webhook-level dedup (prevents reprocessing the same delivery)
    const existing = await this.ctx.storage.get<number>(`${DEDUP_PREFIX}${webhookId}`);
    if (existing) {
      console.log(`[DEBUG] Deduplicated webhook ${webhookId}`);
      return Response.json({ ok: true, deduplicated: true });
    }
    await this.markWebhookSeen(webhookId);

    const messageId = payload.message?.id;
    const senderId = payload.message?.user?.id;
    const messageText = payload.message?.text ?? '';

    console.log(
      `[DEBUG] messageId=${messageId}, senderId=${senderId}, text="${messageText.slice(0, 50)}"`
    );

    if (!messageId || !senderId?.startsWith('bot-')) {
      console.log(`[DEBUG] Skipping: no messageId or not a bot`);
      return Response.json({ ok: true });
    }

    const msgKey = `${MSG_PREFIX}${messageId}`;
    const pendingMessage = await this.ctx.storage.get<PendingMessage>(msgKey);

    if (pendingMessage?.notified) {
      console.log(`[DEBUG] Already notified for message ${messageId}, ignoring`);
      return Response.json({ ok: true });
    }

    if (payload.type === 'message.new') {
      // Store pending message, set debounce alarm
      const pending: PendingMessage = {
        messageId,
        senderId,
        text: messageText,
        notified: false,
        createdAt: Date.now(),
      };
      await this.ctx.storage.put(msgKey, pending);
      await this.scheduleAlarm(DEBOUNCE_MS);
      console.log(`[DEBUG] Stored pending message ${messageId}, alarm in ${DEBOUNCE_MS}ms`);
    } else if (payload.type === 'message.updated') {
      if (!pendingMessage) {
        console.log(`[DEBUG] message.updated for unknown message ${messageId}, ignoring`);
        return Response.json({ ok: true });
      }
      // Update text, reset debounce
      pendingMessage.text = messageText;
      await this.ctx.storage.put(msgKey, pendingMessage);
      await this.scheduleAlarm(DEBOUNCE_MS);
      console.log(
        `[DEBUG] Updated pending message ${messageId}, text="${messageText.slice(0, 50)}", alarm reset`
      );
    }

    return Response.json({ ok: true });
  }

  override async alarm(): Promise<void> {
    console.log(`[DEBUG] Alarm fired`);

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
    let hasRemainingPending = false;

    for (const [key, msg] of pendingEntries) {
      if (msg.notified) {
        // Clean up old notified messages
        if (now - msg.createdAt > DEDUP_TTL_MS) {
          await this.ctx.storage.delete(key);
        }
        continue;
      }

      if (!msg.text) {
        // No text yet — keep waiting but schedule another alarm
        console.log(`[DEBUG] Message ${msg.messageId} still has no text, waiting`);
        hasRemainingPending = true;
        continue;
      }

      console.log(
        `[DEBUG] Sending notification for message ${msg.messageId}: "${msg.text.slice(0, 50)}"`
      );
      await this.sendNotification(msg);
      msg.notified = true;
      await this.ctx.storage.put(key, msg);
    }

    // Re-schedule alarm if we still have pending messages without text
    if (hasRemainingPending) {
      await this.scheduleAlarm(DEBOUNCE_MS);
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

    console.log(
      `[DEBUG] Instance lookup: ${instance ? `id=${instance.id}, user_id=${instance.user_id}, name=${instance.name}` : 'NOT FOUND'}`
    );

    if (!instance) {
      return;
    }

    const tokens = await db
      .select({ token: user_push_tokens.token })
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, instance.user_id));

    console.log(
      `[DEBUG] Push tokens: ${tokens.length} found${tokens.length > 0 ? ` (${tokens.map(t => t.token).join(', ')})` : ''}`
    );

    if (tokens.length === 0) {
      return;
    }

    const truncatedMessage = msg.text.length > 100 ? msg.text.slice(0, 97) + '...' : msg.text;

    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      title: instance.name ?? 'Kilo',
      body: truncatedMessage,
      // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
      data: { type: 'chat', instanceId: instance.id },
      sound: 'default' as const,
      priority: 'high' as const,
    }));

    const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
    console.log(
      `[DEBUG] Expo token: ${accessToken ? `present (${accessToken.length} chars)` : 'MISSING'}`
    );
    console.log(`[DEBUG] Sending:`, JSON.stringify(messages));

    const { ticketTokenPairs, staleTokens } = await sendPushNotifications(messages, accessToken);

    console.log(
      `[DEBUG] Result: ${ticketTokenPairs.length} ticket(s), ${staleTokens.length} stale token(s)`
    );
    if (ticketTokenPairs.length > 0) {
      console.log(`[DEBUG] Tickets:`, JSON.stringify(ticketTokenPairs));
    }

    if (staleTokens.length > 0) {
      await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
      console.log(`[DEBUG] Cleaned up ${staleTokens.length} stale token(s)`);
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
    console.log(`[DEBUG] Alarm scheduled for ${delayMs}ms from now`);
  }
}

export function getNotificationChannelDO(
  env: Env,
  channelId: string
): DurableObjectStub<NotificationChannelDO> {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(channelId);
  return env.NOTIFICATION_CHANNEL_DO.get(id) as DurableObjectStub<NotificationChannelDO>;
}
