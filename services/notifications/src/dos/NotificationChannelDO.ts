import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { badge_counts, user_push_tokens } from '@kilocode/db/schema';
import { type DispatchPushInput, type DispatchPushOutcome } from '@kilocode/notifications';
import { eq, inArray, sql, sum } from 'drizzle-orm';

import type { ExpoPushMessage, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = { ticketTokenPairs: TicketTokenPair[] };

// Two-stage idempotency record. `pending` means the badge was incremented
// for this idempotency key but the Expo send did not (yet) succeed; on
// retry we must skip the increment to avoid double-counting. `delivered`
// means the send succeeded; further attempts are duplicates.
type IdemRecord = { stage: 'pending' | 'delivered'; ts: number };

const IDEM_PREFIX = 'idem:';
const IDEM_TTL_MS = 60 * 60 * 1000; // 1 hour

export class NotificationChannelDO extends DurableObject<Env> {
  async dispatchPush(input: DispatchPushInput): Promise<DispatchPushOutcome> {
    // 1. Idempotency. DO is single-threaded — requests for a given
    //    conversation serialize on this instance. A `failed` outcome
    //    leaves the record at `pending` so upstream can retry the send
    //    without re-incrementing the badge.
    const idemKey = `${IDEM_PREFIX}${input.idempotencyKey}`;
    const existing = await this.ctx.storage.get<IdemRecord>(idemKey);
    if (existing?.stage === 'delivered') return { kind: 'duplicate' };
    const isRetry = existing?.stage === 'pending';

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

    // 4. Badge math. On a retry the badge was already incremented during
    //    the prior attempt; re-applying the delta would double-count.
    //    The total is recomputed in either case (other writers may have
    //    advanced it).
    let badgeTotal: number | undefined;
    if (input.badge) {
      if (!isRetry) {
        // Mark `pending` BEFORE the increment so any later failure path
        // is gated on the marker and a retry skips the increment.
        await this.ctx.storage.put<IdemRecord>(idemKey, {
          stage: 'pending',
          ts: Date.now(),
        });
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
      }
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
      // Leave any `pending` marker in place — retries will re-attempt the
      // send while skipping the badge increment.
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

    // 6. Mark `delivered` so future retries short-circuit as duplicate.
    await this.ctx.storage.put<IdemRecord>(idemKey, {
      stage: 'delivered',
      ts: Date.now(),
    });
    // 7. Schedule cleanup only when no alarm is already pending.
    //    `setAlarm` replaces any existing alarm; calling it on every push
    //    would push cleanup forward indefinitely on a busy conversation.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + IDEM_TTL_MS);
    }

    return { kind: 'delivered', tokenCount: tokens.length };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<IdemRecord>({ prefix: IDEM_PREFIX });
    const expired: string[] = [];
    for (const [key, rec] of entries) {
      if (now - rec.ts > IDEM_TTL_MS) expired.push(key);
    }
    if (expired.length > 0) await this.ctx.storage.delete(expired);
  }
}
