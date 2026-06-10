import { randomUUID } from 'crypto';
import {
  deleteRetainedSecurityAgentCommands,
  reconcileStaleSecurityAgentCommands,
} from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import { discoverDueOwners, reconcileStaleAnalysisQueueRows } from './db/queries.js';
import { logger } from './logger.js';
import { getSecurityAgentCommandLifecycleConfig } from './command-lifecycle-config.js';

const DISPATCH_OWNER_LIMIT = 100;

export async function dispatchDueOwners(env: CloudflareEnv): Promise<{
  dispatchId: string;
  discoveredOwners: number;
  enqueuedMessages: number;
}> {
  const dispatchId = randomUUID();
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });

  const reconciliation = await reconcileStaleAnalysisQueueRows(db);
  logger.info('Reconciled stale analysis queue rows before owner dispatch', {
    requeued_pending_count: reconciliation.requeuedPendingCount,
    failed_running_count: reconciliation.failedRunningCount,
  });

  const now = Date.now();
  const commandLifecycleConfig = getSecurityAgentCommandLifecycleConfig(env);
  const commandReconciliation = await reconcileStaleSecurityAgentCommands(db, {
    acceptedBefore: new Date(now - commandLifecycleConfig.acceptedCommandTimeoutMs),
    runningBefore: new Date(now - commandLifecycleConfig.runningCommandTimeoutMs),
  });
  const deletedCommandCount = await deleteRetainedSecurityAgentCommands(
    db,
    new Date(now - commandLifecycleConfig.commandRetentionMs)
  );
  logger.info('Reconciled stale security agent commands before owner dispatch', {
    stale_accepted_command_ids: commandReconciliation.staleAccepted.map(command => command.id),
    stale_running_command_ids: commandReconciliation.staleRunning.map(command => command.id),
    deleted_terminal_command_count: deletedCommandCount,
  });

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
