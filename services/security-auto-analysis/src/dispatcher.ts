import { randomUUID } from 'crypto';
import { getWorkerDb } from '@kilocode/db/client';
import { discoverDueOwners } from './db/queries.js';
import { logger } from './logger.js';

const DISPATCH_OWNER_LIMIT = 100;

export async function dispatchDueOwners(env: CloudflareEnv): Promise<{
  dispatchId: string;
  discoveredOwners: number;
  enqueuedMessages: number;
}> {
  const dispatchId = randomUUID();
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });

  const owners = await discoverDueOwners(db, DISPATCH_OWNER_LIMIT);

  const messages = owners.map(owner => ({
    body: {
      ownerType: owner.type,
      ownerId: owner.id,
      dispatchId,
      enqueuedAt: new Date().toISOString(),
    },
    contentType: 'json' as const,
  }));

  const QUEUE_SEND_BATCH_LIMIT = 100;
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    await env.OWNER_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
  }

  logger.info('Dispatched due owners to queue', {
    dispatch_id: dispatchId,
    discovered_owners: owners.length,
    enqueued_messages: messages.length,
  });

  return {
    dispatchId,
    discoveredOwners: owners.length,
    enqueuedMessages: messages.length,
  };
}
