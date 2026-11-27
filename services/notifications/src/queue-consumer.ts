import { getWorkerDb } from '@kilocode/db/client';
import { user_push_tokens } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';

import type { TicketTokenPair } from './lib/expo-push';
import { checkPushReceipts } from './lib/expo-push';
import { skipProviderPush } from './lib/push-gate';
import { readNotificationsSecret } from './secrets';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

export async function queue(
  batch: MessageBatch<ReceiptCheckMessage>,
  env: Env,
  ctx: SecretsExecutionContext
): Promise<void> {
  // Receipt work published before the staging push gate closed is
  // acknowledged, not retried: checking it would read the Expo credential and
  // call Expo.
  if (skipProviderPush(env, 'expo_receipts')) {
    for (const msg of batch.messages) msg.ack();
    return;
  }
  for (const msg of batch.messages) {
    try {
      await processReceiptCheck(env, msg.body, ctx);
      msg.ack();
    } catch (err) {
      console.error('Receipt check failed, will retry', {
        ticketCount: msg.body.ticketTokenPairs.length,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}

async function processReceiptCheck(
  env: Env,
  message: ReceiptCheckMessage,
  ctx: SecretsExecutionContext
): Promise<void> {
  const accessToken = await readNotificationsSecret(env, 'NOTIFICATIONS_EXPO_ACCESS_TOKEN', ctx);
  const { staleTokens, receiptErrors } = await checkPushReceipts(
    message.ticketTokenPairs,
    accessToken
  );

  if (staleTokens.length > 0) {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString);
    await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
    console.log(`Receipt check: cleaned up ${staleTokens.length} stale push token(s)`);
  }

  if (receiptErrors.length > 0) {
    console.warn('Receipt check returned non-stale Expo receipt error(s)', {
      errorCount: receiptErrors.length,
      errors: receiptErrors.map(error => ({
        ticketId: error.ticketId,
        errorCode: error.errorCode,
        message: error.message,
      })),
    });
  }
}
