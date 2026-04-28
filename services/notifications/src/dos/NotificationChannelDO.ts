import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { badge_counts, kiloclaw_instances, user_push_tokens } from '@kilocode/db/schema';
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

export type DispatchPushInput = {
  userId: string;
  presenceContext: string;
  idempotencyKey: string;
  badge: { badgeBucket: string; delta: number } | null;
  push: {
    title: string;
    body: string;
    data: Record<string, unknown>;
    sound?: 'default' | null;
    priority?: 'default' | 'high';
  };
};

export type DispatchPushOutcome =
  | { kind: 'delivered'; tokenCount: number }
  | { kind: 'suppressed_presence' }
  | { kind: 'no_tokens' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

/** Dependencies injected into `dispatchPushCore` to make it unit-testable. */
export type DispatchPushDeps = {
  storage: DurableObjectStorage;
  isUserInContext: (userId: string, context: string) => Promise<boolean>;
  getAccessToken: () => Promise<string>;
  sendPush: typeof sendPushNotifications;
  db: ReturnType<typeof getWorkerDb>;
  sendToQueue: (msg: ReceiptCheckMessage) => Promise<void>;
};

/**
 * Pure implementation of the dispatchPush logic with injected dependencies.
 * Exported so it can be unit-tested without standing up a Durable Object.
 */
export async function dispatchPushCore(
  input: DispatchPushInput,
  deps: DispatchPushDeps
): Promise<DispatchPushOutcome> {
  const idemKey = `idem:${input.idempotencyKey}`;
  const existing = await deps.storage.get<number>(idemKey);
  if (existing !== undefined) return { kind: 'duplicate' };

  const inContext = await deps.isUserInContext(input.userId, input.presenceContext);
  if (inContext) return { kind: 'suppressed_presence' };

  const tokens = await deps.db
    .select({ token: user_push_tokens.token })
    .from(user_push_tokens)
    .where(eq(user_push_tokens.user_id, input.userId));

  if (tokens.length === 0) return { kind: 'no_tokens' };

  let badgeTotal: number | undefined;
  if (input.badge !== null) {
    await deps.db
      .insert(badge_counts)
      .values({
        user_id: input.userId,
        badge_bucket: input.badge.badgeBucket,
        badge_count: input.badge.delta,
      })
      .onConflictDoUpdate({
        target: [badge_counts.user_id, badge_counts.badge_bucket],
        set: { badge_count: sql`${badge_counts.badge_count} + ${input.badge.delta}` },
      });

    const [totals] = await deps.db
      .select({ total: sum(badge_counts.badge_count) })
      .from(badge_counts)
      .where(eq(badge_counts.user_id, input.userId));

    badgeTotal = Number(totals?.total ?? 0);
  }

  const expoMessages: ExpoPushMessage[] = tokens.map(({ token }) => ({
    to: token,
    title: input.push.title,
    body: input.push.body,
    data: input.push.data,
    sound: input.push.sound ?? undefined,
    priority: input.push.priority ?? 'default',
    ...(badgeTotal !== undefined ? { badge: badgeTotal } : {}),
  }));

  try {
    const accessToken = await deps.getAccessToken();
    const { ticketTokenPairs, staleTokens } = await deps.sendPush(expoMessages, accessToken);

    if (staleTokens.length > 0) {
      await deps.db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
    }

    if (ticketTokenPairs.length > 0) {
      await deps.sendToQueue({ ticketTokenPairs });
    }

    await deps.storage.put(idemKey, Date.now());

    return { kind: 'delivered', tokenCount: tokens.length };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

const DEDUP_PREFIX = 'dedup:';
const MSG_PREFIX = 'msg:';
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEBOUNCE_MS = 10_000; // 10 seconds

export class NotificationChannelDO extends DurableObject<Env> {
  /**
   * Mechanical primitive: presence check → token lookup → badge math → Expo send → idempotency.
   * Callers construct the input and delegate here; this method owns no domain logic.
   */
  async dispatchPush(input: DispatchPushInput): Promise<DispatchPushOutcome> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);
    return dispatchPushCore(input, {
      storage: this.ctx.storage,
      isUserInContext: (userId, context) => this.env.EVENT_SERVICE.isUserInContext(userId, context),
      getAccessToken: () => this.env.EXPO_ACCESS_TOKEN.get(),
      sendPush: sendPushNotifications,
      db,
      sendToQueue: msg => this.env.RECEIPTS_QUEUE.send(msg, { delaySeconds: 900 }),
    });
  }

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

    const truncatedMessage = msg.text.length > 100 ? msg.text.slice(0, 97) + '...' : msg.text;

    await this.dispatchPush({
      userId: instance.user_id,
      presenceContext: `/kiloclaw/${sandboxId}`,
      idempotencyKey: `stream:${msg.messageId}`,
      badge: { badgeBucket: sandboxId, delta: 1 },
      push: {
        title: instance.name ?? 'KiloClaw',
        body: truncatedMessage,
        // Keep in sync with NotificationData in apps/mobile/src/lib/notifications.ts
        data: { type: 'chat', instanceId: sandboxId },
        sound: 'default',
        priority: 'high',
      },
    });
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
