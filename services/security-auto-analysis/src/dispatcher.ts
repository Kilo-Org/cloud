import { randomUUID } from 'crypto';
import {
  deleteRetainedSecurityAgentCommands,
  reconcileStaleSecurityAgentCommands,
  type SecurityAgentCommand,
} from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import { discoverDueOwners, reconcileStaleAnalysisQueueRows } from './db/queries.js';
import { logger, sanitizedExceptionName, type DispatcherStage } from './logger.js';
import { getSecurityAgentCommandLifecycleConfig } from './command-lifecycle-config.js';
import { discoverQueuedRemediationAttempts } from './remediation.js';

const DISPATCH_OWNER_LIMIT = 100;
const DISPATCH_REMEDIATION_ATTEMPT_LIMIT = 100;
const QUEUE_SEND_BATCH_LIMIT = 100;
const DISPATCH_STAGE_SUCCEEDED_EVENT = 'security_auto_analysis.dispatcher_stage_succeeded';
const DISPATCH_FAILED_EVENT = 'security_auto_analysis.dispatcher_failed';
const COMMAND_STALLED_EVENT = 'security_auto_analysis.command_stalled';

function logStalledCommands(reconciliation: {
  staleAccepted: SecurityAgentCommand[];
  staleRunning: SecurityAgentCommand[];
}): void {
  for (const [previousStatus, commands] of [
    ['accepted', reconciliation.staleAccepted] as const,
    ['running', reconciliation.staleRunning] as const,
  ]) {
    for (const command of commands) {
      const timestamp =
        previousStatus === 'running'
          ? (command.started_at ?? command.accepted_at)
          : command.accepted_at;
      const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
      logger
        .withTags({
          event_name: COMMAND_STALLED_EVENT,
          command_id: command.id,
          command_type: command.command_type,
          owner_type: command.owned_by_organization_id ? 'org' : 'user',
          owner_id: command.owned_by_organization_id ?? command.owned_by_user_id ?? undefined,
          previous_status: previousStatus,
          result_code: command.result_code ?? null,
          started_at: command.started_at ?? null,
          accepted_at: command.accepted_at ?? null,
          age_ms: Number.isFinite(parsed) ? Date.now() - parsed : null,
          repo_full_name: command.repo_full_name ?? null,
        })
        .info(COMMAND_STALLED_EVENT);
    }
  }
}

async function runDispatcherStage<T>(options: {
  stage: DispatcherStage;
  dispatchId: string;
  env: CloudflareEnv;
  operation: () => Promise<T>;
  successTags?: (result: T) => Record<string, number>;
}): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await options.operation();
    logger
      .withTags({
        event_name: DISPATCH_STAGE_SUCCEEDED_EVENT,
        dispatcher_stage: options.stage,
        dispatch_id: options.dispatchId,
        outcome: 'succeeded',
        elapsed_ms: Date.now() - startedAt,
        worker_environment: options.env.ENVIRONMENT,
        worker_version: options.env.CF_VERSION_METADATA?.id,
        ...options.successTags?.(result),
      })
      .info(DISPATCH_STAGE_SUCCEEDED_EVENT);
    return result;
  } catch (error) {
    logger
      .withTags({
        event_name: DISPATCH_FAILED_EVENT,
        dispatcher_stage: options.stage,
        dispatch_id: options.dispatchId,
        outcome: 'failed',
        exception_name: sanitizedExceptionName(error),
        error_message: 'Dispatcher stage failed',
        elapsed_ms: Date.now() - startedAt,
        worker_environment: options.env.ENVIRONMENT,
        worker_version: options.env.CF_VERSION_METADATA?.id,
      })
      .error(DISPATCH_FAILED_EVENT);
    throw error;
  }
}

export async function dispatchDueOwners(
  env: CloudflareEnv,
  dispatchId: string = randomUUID()
): Promise<{
  dispatchId: string;
  discoveredOwners: number;
  enqueuedMessages: number;
  discoveredRemediationAttempts: number;
  enqueuedRemediationMessages: number;
}> {
  const { db, reconciliation } = await runDispatcherStage({
    stage: 'stale_analysis_queue_reconciliation',
    dispatchId,
    env,
    operation: async () => {
      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
      const reconciliation = await reconcileStaleAnalysisQueueRows(db);
      return { db, reconciliation };
    },
    successTags: ({ reconciliation }) => ({
      requeued_pending_count: reconciliation.requeuedPendingCount,
      failed_running_count: reconciliation.failedRunningCount,
    }),
  });

  const now = Date.now();
  const { commandLifecycleConfig, commandReconciliation } = await runDispatcherStage({
    stage: 'stale_command_reconciliation',
    dispatchId,
    env,
    operation: async () => {
      const commandLifecycleConfig = getSecurityAgentCommandLifecycleConfig(env);
      const commandReconciliation = await reconcileStaleSecurityAgentCommands(db, {
        acceptedBefore: new Date(now - commandLifecycleConfig.acceptedCommandTimeoutMs),
        runningBefore: new Date(now - commandLifecycleConfig.runningCommandTimeoutMs),
      });
      return { commandLifecycleConfig, commandReconciliation };
    },
    successTags: ({ commandReconciliation }) => ({
      stale_accepted_command_count: commandReconciliation.staleAccepted.length,
      stale_running_command_count: commandReconciliation.staleRunning.length,
    }),
  });

  logStalledCommands(commandReconciliation);

  const deletedCommandCount = await runDispatcherStage({
    stage: 'retained_command_deletion',
    dispatchId,
    env,
    operation: () =>
      deleteRetainedSecurityAgentCommands(
        db,
        new Date(now - commandLifecycleConfig.commandRetentionMs)
      ),
    successTags: count => ({ deleted_terminal_command_count: count }),
  });

  const owners = await runDispatcherStage({
    stage: 'due_owner_discovery',
    dispatchId,
    env,
    operation: () => discoverDueOwners(db, DISPATCH_OWNER_LIMIT),
    successTags: result => ({ discovered_owner_count: result.length }),
  });

  const messages = owners.map(owner => ({
    body: {
      ownerType: owner.type,
      ownerId: owner.id,
      dispatchId,
      enqueuedAt: new Date().toISOString(),
    },
    contentType: 'json' as const,
  }));

  await runDispatcherStage({
    stage: 'owner_queue_sends',
    dispatchId,
    env,
    operation: async () => {
      for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
        await env.OWNER_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
      }
    },
    successTags: () => ({ enqueued_owner_message_count: messages.length }),
  });

  const remediationAttemptIds = await runDispatcherStage({
    stage: 'remediation_attempt_discovery',
    dispatchId,
    env,
    operation: () => discoverQueuedRemediationAttempts(db, DISPATCH_REMEDIATION_ATTEMPT_LIMIT),
    successTags: result => ({ discovered_remediation_attempt_count: result.length }),
  });
  const remediationMessages = remediationAttemptIds.map(attemptId => ({
    body: {
      attemptId,
      dispatchId,
      enqueuedAt: new Date().toISOString(),
    },
    contentType: 'json' as const,
  }));

  await runDispatcherStage({
    stage: 'remediation_queue_sends',
    dispatchId,
    env,
    operation: async () => {
      for (let i = 0; i < remediationMessages.length; i += QUEUE_SEND_BATCH_LIMIT) {
        await env.REMEDIATION_ATTEMPT_QUEUE.sendBatch(
          remediationMessages.slice(i, i + QUEUE_SEND_BATCH_LIMIT)
        );
      }
    },
    successTags: () => ({ enqueued_remediation_message_count: remediationMessages.length }),
  });

  logger
    .withTags({
      event_name: 'security_auto_analysis.dispatcher_succeeded',
      dispatch_id: dispatchId,
      outcome: 'succeeded',
      worker_environment: env.ENVIRONMENT,
      worker_version: env.CF_VERSION_METADATA?.id,
      requeued_pending_count: reconciliation.requeuedPendingCount,
      failed_running_count: reconciliation.failedRunningCount,
      stale_accepted_command_count: commandReconciliation.staleAccepted.length,
      stale_running_command_count: commandReconciliation.staleRunning.length,
      deleted_terminal_command_count: deletedCommandCount,
      discovered_owner_count: owners.length,
      enqueued_owner_message_count: messages.length,
      discovered_remediation_attempt_count: remediationAttemptIds.length,
      enqueued_remediation_message_count: remediationMessages.length,
    })
    .info('security_auto_analysis.dispatcher_succeeded');

  return {
    dispatchId,
    discoveredOwners: owners.length,
    enqueuedMessages: messages.length,
    discoveredRemediationAttempts: remediationAttemptIds.length,
    enqueuedRemediationMessages: remediationMessages.length,
  };
}
