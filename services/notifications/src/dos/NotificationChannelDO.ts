import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { badge_counts, user_push_tokens } from '@kilocode/db/schema';
import { type DispatchPushInput, type DispatchPushOutcome } from '@kilocode/notifications';
import { eq, inArray, sql, sum } from 'drizzle-orm';

import type { ExpoPushMessage, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = { ticketTokenPairs: TicketTokenPair[] };

const IDEM_PREFIX = 'idem:';
const IDEM_TTL_MS = 60 * 60 * 1000; // 1 hour

export class NotificationChannelDO extends DurableObject<Env> {
  async dispatchPush(input: DispatchPushInput): Promise<DispatchPushOutcome> {
    // 1. Idempotency. DO is single-threaded, requests for a given conversation
    //    serialize on this instance. A `failed` outcome does NOT write the
    //    idempotency key, so the next attempt can retry.
    const idemKey = `${IDEM_PREFIX}${input.idempotencyKey}`;
    const seen = await this.ctx.storage.get<number>(idemKey);
    if (seen) return { kind: 'duplicate' };

    // 2. Presence
    const inContext = await this.env.EVENT_SERVICE.isUserInContext(
      input.userId,
      input.presenceContext
    );
    if (inContext) return { kind: 'suppressed_presence' };

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    // 3. Tokens
    const tokens = await db
      .select({ token: user_push_tokens.token })
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, input.userId));

    if (tokens.length === 0) return { kind: 'no_tokens' };

    // 4. Badge math (only if badge is set).
    let badgeTotal: number | undefined;
    if (input.badge) {
      await db
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
      const [totals] = await db
        .select({ total: sum(badge_counts.badge_count) })
        .from(badge_counts)
        .where(eq(badge_counts.user_id, input.userId));
      badgeTotal = Number(totals?.total ?? 0);
    }

    // 5. Send via Expo
    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      title: input.push.title,
      body: input.push.body,
      data: input.push.data,
      ...(badgeTotal !== undefined && { badge: badgeTotal }),
      sound: input.push.sound ?? undefined,
      priority: input.push.priority ?? 'default',
    }));

    const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
    let result: { ticketTokenPairs: TicketTokenPair[]; staleTokens: string[] };
    try {
      result = await sendPushNotifications(messages, accessToken);
    } catch (err) {
      // Intentionally do NOT write the idempotency key on failure — let
      // upstream retry. The DO's single-threading prevents concurrent
      // double-sends within the same conversation.
      return {
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.staleTokens.length > 0) {
      await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, result.staleTokens));
    }

    if (result.ticketTokenPairs.length > 0) {
      const receiptMsg: ReceiptCheckMessage = { ticketTokenPairs: result.ticketTokenPairs };
      await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
    }

    // 6. Idempotency write — only after a successful send.
    await this.ctx.storage.put(idemKey, Date.now());
    await this.ctx.storage.setAlarm(Date.now() + IDEM_TTL_MS);

    return { kind: 'delivered', tokenCount: tokens.length };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: IDEM_PREFIX });
    const expired: string[] = [];
    for (const [key, ts] of entries) {
      if (now - ts > IDEM_TTL_MS) expired.push(key);
    }
    if (expired.length > 0) await this.ctx.storage.delete(expired);
  }
}
