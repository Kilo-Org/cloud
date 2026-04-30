import { WorkerEntrypoint } from 'cloudflare:workers';
import { getWorkerDb } from '@kilocode/db/client';
import { user_push_tokens } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import type { TicketTokenPair } from './expo-push';
import { sendPushNotifications } from './expo-push';
import {
  dispatchInstanceLifecyclePush,
  type SendInstanceLifecycleNotificationParams,
  type SendInstanceLifecycleNotificationResult,
} from './instance-lifecycle-push';

export type {
  InstanceLifecycleEvent,
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from './instance-lifecycle-push';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

/**
 * RPC entrypoint for other Workers to send non-chat push notifications.
 *
 * Callers authenticate implicitly via the binding topology — only Workers
 * explicitly bound to `notifications` with `entrypoint: "NotificationsService"`
 * can reach these methods. No shared secret is needed.
 *
 * Keep `data.type` values in sync with `NotificationData` in
 * `apps/mobile/src/lib/notifications.ts`.
 */
export class NotificationsService extends WorkerEntrypoint<Env> {
  async sendInstanceLifecycleNotification(
    params: SendInstanceLifecycleNotificationParams
  ): Promise<SendInstanceLifecycleNotificationResult> {
    const db = getWorkerDb(this.env.HYPERDRIVE.connectionString);

    const result = await dispatchInstanceLifecyclePush(params, {
      getTokens: async userId => {
        const rows = await db
          .select({ token: user_push_tokens.token })
          .from(user_push_tokens)
          .where(eq(user_push_tokens.user_id, userId));
        return rows.map(r => r.token);
      },
      deleteStaleTokens: async tokens => {
        await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, tokens));
      },
      sendPush: async messages => {
        const accessToken = await this.env.EXPO_ACCESS_TOKEN.get();
        return sendPushNotifications(messages, accessToken);
      },
      enqueueReceipts: async ticketTokenPairs => {
        const receiptMsg: ReceiptCheckMessage = { ticketTokenPairs };
        await this.env.RECEIPTS_QUEUE.send(receiptMsg, { delaySeconds: 900 });
      },
    });

    return result;
  }
}
