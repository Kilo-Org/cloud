import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { badge_counts, user_push_tokens } from '@kilocode/db/schema';
import { eq, inArray, sql, sum } from 'drizzle-orm';

import type { ExpoPushMessage, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
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
}

export function getNotificationChannelDO(
  env: Env,
  channelId: string
): DurableObjectStub<NotificationChannelDO> {
  const id = env.NOTIFICATION_CHANNEL_DO.idFromName(channelId);
  return env.NOTIFICATION_CHANNEL_DO.get(id) as DurableObjectStub<NotificationChannelDO>;
}
