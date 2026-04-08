import { getWorkerDb } from '@kilocode/db/client';
import { user_push_tokens } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

import type { TicketTokenPair } from './lib/expo-push';
import { checkPushReceipts } from './lib/expo-push';

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

export async function queue(batch: MessageBatch<ReceiptCheckMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processReceiptCheck(env, msg.body);
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

async function processReceiptCheck(env: Env, message: ReceiptCheckMessage): Promise<void> {
  const accessToken = await env.EXPO_ACCESS_TOKEN.get();
  const staleTokens = await checkPushReceipts(message.ticketTokenPairs, accessToken);

  if (staleTokens.length > 0) {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString);
    await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
    console.log(`Receipt check: cleaned up ${staleTokens.length} stale push token(s)`);
  }
}
