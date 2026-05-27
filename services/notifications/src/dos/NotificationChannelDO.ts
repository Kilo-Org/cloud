import { DurableObject } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { user_push_tokens } from '@kilocode/db/schema';
import { type DispatchPushInput, type DispatchPushOutcome } from '@kilocode/notifications';
import { eq, inArray } from 'drizzle-orm';

import type { ExpoPushMessage, SendResult, TicketTokenPair } from '../lib/expo-push';
import { sendPushNotifications } from '../lib/expo-push';

type ReceiptCheckMessage = { ticketTokenPairs: TicketTokenPair[] };

// `pending` means badge mutation happened before an Expo attempt and must not
// repeat. `accepted` means Expo accepted at least one push and only post-send
// bookkeeping may be retried. Terminal stages make later attempts duplicates.
type TerminalIdemRecord = {
  stage: 'pending' | 'delivered' | 'suppressed' | 'no_tokens' | 'failed';
  ts: number;
};

type AcceptedDeliveryIdemRecord = {
  stage: 'accepted';
  ts: number;
  ticketTokenPairs: TicketTokenPair[];
  staleTokens: string[];
  finalStage: 'delivered' | 'failed';
};

type IdemRecord = TerminalIdemRecord | AcceptedDeliveryIdemRecord;

const IDEM_PREFIX = 'idem:';
const BUCKET_PREFIX = 'bucket:';
const TOTAL_KEY = 'total';
const IDEM_TTL_MS = 60 * 60 * 1000; // 1 hour
const ACCEPTED_BOOKKEEPING_RETRY_DELAY_MS = 30_000;

export class NotificationChannelDO extends DurableObject<Env> {
  async dispatchPush(input: DispatchPushInput): Promise<DispatchPushOutcome> {
    // 1. Idempotency. DO is single-threaded — requests for a given
    //    user serialize on this instance. Retryable send failures leave the
    //    record at `pending` so upstream can retry the send without
    //    re-incrementing the badge.
    const idemKey = `${IDEM_PREFIX}${input.idempotencyKey}`;
    const existing = await this.ctx.storage.get<IdemRecord>(idemKey);
    if (existing?.stage === 'accepted') {
      const bookkeepingError = await this.completeAcceptedDelivery(idemKey, existing);
      if (bookkeepingError) {
        await this.requestAcceptedBookkeepingRepair();
        return { kind: 'failed', error: bookkeepingError };
      }
      return { kind: 'duplicate' };
    }
    if (
      existing?.stage === 'delivered' ||
      existing?.stage === 'suppressed' ||
      existing?.stage === 'no_tokens' ||
      existing?.stage === 'failed'
    ) {
      return { kind: 'duplicate' };
    }
    const isRetry = existing?.stage === 'pending';

    // 2. Presence
    if (input.presenceContext) {
      let inContext = false;
      try {
        inContext = await this.env.EVENT_SERVICE.isUserInContext(
          input.userId,
          input.presenceContext
        );
      } catch (err) {
        console.warn('Presence lookup failed while dispatching push; continuing delivery', {
          presenceContext: input.presenceContext,
          badgeBucket: input.badge?.badgeBucket,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (inContext) {
        const ts = Date.now();
        await this.ctx.storage.put<IdemRecord>(idemKey, { stage: 'suppressed', ts });
        await this.ensureCleanupAlarm(ts);
        return { kind: 'suppressed_presence' };
      }
    }

    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    // 3. Badge math. On a retry the badge was already incremented during
    //    the prior attempt; re-applying the delta would double-count.
    //    The total is recomputed in either case (other writers may have
    //    advanced it).
    let badgeTotal: number | undefined;
    if (input.badge) {
      if (!isRetry) {
        // Mark `pending` BEFORE the increment so any later failure path
        // is gated on the marker and a retry skips the increment.
        const ts = Date.now();
        await this.ctx.storage.put<IdemRecord>(idemKey, { stage: 'pending', ts });
        // Also schedule cleanup at this point — if Expo keeps failing and
        // no future push ever lands, `pending` would otherwise leak.
        await this.ensureCleanupAlarm(ts);
        badgeTotal = await this.incrementBucket(input.badge.badgeBucket, input.badge.delta);
      } else {
        badgeTotal = await this.getTotal();
      }
    }

    // 4. Tokens. Missing Expo tokens only means no OS push can be sent; the
    //    in-app badge state above is still authoritative for client hydration.
    const tokens = await db
      .select({ token: user_push_tokens.token })
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, input.userId));

    if (tokens.length === 0) {
      const ts = Date.now();
      await this.ctx.storage.put<IdemRecord>(idemKey, { stage: 'no_tokens', ts });
      await this.ensureCleanupAlarm(ts);
      return { kind: 'no_tokens' };
    }

    // 5. Send via Expo
    const messages: ExpoPushMessage[] = tokens.map(
      ({ token }) =>
        ({
          to: token,
          title: input.push.title,
          body: input.push.body,
          data: input.push.data,
          ...(badgeTotal !== undefined && { badge: badgeTotal }),
          sound: input.push.sound ?? undefined,
          priority: input.push.priority ?? 'default',
        }) satisfies ExpoPushMessage
    );

    const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
    let result: SendResult;
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

    if (result.ticketTokenPairs.length > 0) {
      const plural = result.ticketErrors.length === 1 ? '' : 's';
      const deliveryOutcome: DispatchPushOutcome =
        result.ticketErrors.length > 0
          ? {
              kind: 'failed',
              error: `Expo rejected ${result.ticketErrors.length} push ticket${plural}`,
            }
          : { kind: 'delivered', tokenCount: result.ticketTokenPairs.length };
      const acceptedDelivery = {
        stage: 'accepted',
        ts: Date.now(),
        ticketTokenPairs: result.ticketTokenPairs,
        staleTokens: result.staleTokens,
        finalStage: result.ticketErrors.length > 0 ? 'failed' : 'delivered',
      } satisfies AcceptedDeliveryIdemRecord;

      // Persist acceptance before side effects that can fail independently. A
      // replay then repairs bookkeeping rather than sending another OS push.
      await this.ctx.storage.put<IdemRecord>(idemKey, acceptedDelivery);
      try {
        await this.ensureCleanupAlarm(acceptedDelivery.ts);
      } catch (error) {
        console.warn('Failed to schedule accepted push cleanup before bookkeeping; continuing', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const bookkeepingError = await this.completeAcceptedDelivery(idemKey, acceptedDelivery, db);
      if (bookkeepingError) {
        await this.requestAcceptedBookkeepingRepair();
        return { kind: 'failed', error: bookkeepingError };
      }
      return deliveryOutcome;
    }

    if (result.staleTokens.length > 0) {
      await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, result.staleTokens));
    }

    if (result.ticketErrors.length > 0) {
      const isTerminalFailure = result.ticketErrors.every(ticketError => !ticketError.retryable);
      if (isTerminalFailure) {
        const ts = Date.now();
        await this.ctx.storage.put<IdemRecord>(idemKey, { stage: 'failed', ts });
        await this.ensureCleanupAlarm(ts);
      }

      const plural = result.ticketErrors.length === 1 ? '' : 's';
      return {
        kind: 'failed',
        error: `Expo rejected ${result.ticketErrors.length} push ticket${plural}`,
      };
    }

    if (result.staleTokens.length > 0) {
      const ts = Date.now();
      await this.ctx.storage.put<IdemRecord>(idemKey, { stage: 'no_tokens', ts });
      await this.ensureCleanupAlarm(ts);
      return { kind: 'no_tokens' };
    }

    console.warn('Expo returned no classified ticket outcomes for attempted push dispatch', {
      tokenCount: tokens.length,
      hasBadge: input.badge !== null,
    });
    return { kind: 'failed', error: 'Expo returned no classified push ticket outcomes' };
  }

  private async completeAcceptedDelivery(
    idemKey: string,
    record: AcceptedDeliveryIdemRecord,
    db = getWorkerDb(this.env.HYPERDRIVE.connectionString)
  ): Promise<string | null> {
    try {
      if (record.staleTokens.length > 0) {
        await db
          .delete(user_push_tokens)
          .where(inArray(user_push_tokens.token, record.staleTokens));
      }

      const receiptMsg = {
        ticketTokenPairs: record.ticketTokenPairs,
      } satisfies ReceiptCheckMessage;
      await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });

      const ts = Date.now();
      await this.ctx.storage.put<IdemRecord>(idemKey, { stage: record.finalStage, ts });
      await this.ensureCleanupAlarm(ts);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Accepted push bookkeeping failed: ${message}`;
    }
  }

  private async requestAcceptedBookkeepingRepair(): Promise<void> {
    const repairAt = Date.now() + ACCEPTED_BOOKKEEPING_RETRY_DELAY_MS;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > repairAt) {
      await this.ctx.storage.setAlarm(repairAt);
    }
  }

  /**
   * Clear a bucket and return the user's new total. Called when a user
   * marks a conversation as read.
   */
  async markBucketRead(bucket: string): Promise<number> {
    const key = `${BUCKET_PREFIX}${bucket}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (current <= 0) {
      return this.getTotalWithoutPersisting();
    }

    const total = await this.getTotal();
    await this.ctx.storage.delete(key);
    const nextTotal = Math.max(0, total - current);
    await this.ctx.storage.put<number>(TOTAL_KEY, nextTotal);
    return nextTotal;
  }

  /**
   * Return all non-zero buckets for this user, used to hydrate clients on
   * cold start.
   */
  async listNonZeroBuckets(): Promise<{ badgeBucket: string; badgeCount: number }[]> {
    const entries = await this.ctx.storage.list<number>({ prefix: BUCKET_PREFIX });
    const out: { badgeBucket: string; badgeCount: number }[] = [];
    for (const [key, count] of entries) {
      if (count > 0) {
        out.push({ badgeBucket: key.slice(BUCKET_PREFIX.length), badgeCount: count });
      }
    }
    return out;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<IdemRecord>({ prefix: IDEM_PREFIX });
    const expired: string[] = [];
    let nextAlarmAt: number | undefined;
    const requestAlarmAtOrBefore = (deadline: number) => {
      if (nextAlarmAt === undefined || deadline < nextAlarmAt) {
        nextAlarmAt = deadline;
      }
    };

    for (const [key, rec] of entries) {
      if (rec.stage === 'accepted') {
        const bookkeepingError = await this.completeAcceptedDelivery(key, rec);
        if (bookkeepingError) {
          console.warn('Accepted push bookkeeping repair failed', { error: bookkeepingError });
          requestAlarmAtOrBefore(now + ACCEPTED_BOOKKEEPING_RETRY_DELAY_MS);
        } else {
          requestAlarmAtOrBefore(Date.now() + IDEM_TTL_MS);
        }
        continue;
      }

      if (now - rec.ts > IDEM_TTL_MS) {
        expired.push(key);
      } else {
        requestAlarmAtOrBefore(rec.ts + IDEM_TTL_MS);
      }
    }
    if (expired.length > 0) await this.ctx.storage.delete(expired);
    if (nextAlarmAt !== undefined) {
      await this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }

  // Schedule cleanup `IDEM_TTL_MS` from `refTs` only if no alarm is pending.
  // `setAlarm` replaces any existing alarm; calling it unconditionally would
  // push cleanup forward indefinitely on a busy user.
  private async ensureCleanupAlarm(refTs: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(refTs + IDEM_TTL_MS);
    }
  }

  // Read-modify-write of a bucket counter. The DO is single-threaded, so
  // this is race-free without explicit locking.
  private async incrementBucket(bucket: string, delta: number): Promise<number> {
    const key = `${BUCKET_PREFIX}${bucket}`;
    const total = await this.getTotal();
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    const next = Math.max(0, current + delta);
    if (next === 0) {
      await this.ctx.storage.delete(key);
    } else {
      await this.ctx.storage.put<number>(key, next);
    }

    const nextTotal = Math.max(0, total + delta);
    await this.ctx.storage.put<number>(TOTAL_KEY, nextTotal);
    return nextTotal;
  }

  // Aggregate badge count. Existing DOs without the aggregate fall back to one
  // bucket scan and persist the total for subsequent push/read paths.
  private async getTotal(): Promise<number> {
    const stored = await this.ctx.storage.get<number>(TOTAL_KEY);
    if (stored !== undefined) return stored;

    const entries = await this.ctx.storage.list<number>({ prefix: BUCKET_PREFIX });
    let total = 0;
    for (const value of entries.values()) total += value;
    await this.ctx.storage.put<number>(TOTAL_KEY, total);
    return total;
  }

  private async getTotalWithoutPersisting(): Promise<number> {
    const stored = await this.ctx.storage.get<number>(TOTAL_KEY);
    if (stored !== undefined) return stored;

    const entries = await this.ctx.storage.list<number>({ prefix: BUCKET_PREFIX });
    let total = 0;
    for (const value of entries.values()) total += value;
    return total;
  }
}
