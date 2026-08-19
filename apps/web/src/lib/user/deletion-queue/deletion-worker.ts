import { captureException } from '@sentry/nextjs';
import type { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  USER_DELETION_INTERNAL_DEADLINE_MS,
  USER_DELETION_MAX_CONCURRENT_TASKS,
  USER_DELETION_OUTCOME_PERSIST_RESERVE_MS,
  USER_DELETION_STOP_STARTING_RESERVE_MS,
  USER_DELETION_TASK_LEASE_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  persistHandlerOutcome,
  persistRejectedPreflight,
} from '@/lib/user/deletion-queue/deletion-outcomes';
import {
  advanceDeletionGates,
  sweepUnclaimableDeletionGates,
} from '@/lib/user/deletion-queue/deletion-completion';
import { runDeletionPreflight } from '@/lib/user/deletion-queue/deletion-preflight';
import { selectEligibleDeletionRequest } from '@/lib/user/deletion-queue/deletion-request-selector';
import { runClaimedDeletionTask } from '@/lib/user/deletion-queue/deletion-task-runner';
import { claimNextTaskForRequest } from '@/lib/user/deletion-queue/deletion-task-selector';

export type DeletionWorkerResult = {
  outcome: 'success' | 'failure';
  processed: number;
};

type WaveItemExecution =
  | { kind: 'durable'; applied: boolean }
  | { kind: 'failed'; failurePersisted: boolean };

export async function runUserDeletionWorker(params?: {
  now?: number;
}): Promise<DeletionWorkerResult> {
  const startedAt = params?.now ?? Date.now();
  const deadlineAt = startedAt + USER_DELETION_INTERNAL_DEADLINE_MS;
  const handlerDeadlineAt = deadlineAt - USER_DELETION_OUTCOME_PERSIST_RESERVE_MS;

  let processed = 0;
  try {
    while (handlerDeadlineAt - Date.now() > USER_DELETION_STOP_STARTING_RESERVE_MS) {
      const wave = await buildDeletionWave(handlerDeadlineAt);
      if (wave.length === 0) break;
      const results = await Promise.all(wave.map(item => executeWaveItem(item, handlerDeadlineAt)));
      let waveFailed = false;
      for (const result of results) {
        if (result.kind === 'durable' && result.applied) {
          processed += 1;
        }
        if (result.kind === 'failed') {
          waveFailed = true;
        }
      }
      if (waveFailed) {
        return { outcome: 'failure', processed };
      }
      const requestIds = [...new Set(wave.map(item => item.requestId))];
      for (const requestId of requestIds) {
        await advanceDeletionGates(requestId);
      }
    }
    await sweepUnclaimableDeletionGates(handlerDeadlineAt);
    return { outcome: 'success', processed };
  } catch (error) {
    captureException(error, {
      tags: { source: 'user-deletion-worker' },
    });
    return { outcome: 'failure', processed };
  }
}

type WaveItem =
  | { kind: 'preflight'; requestId: string }
  | {
      kind: 'task';
      requestId: string;
      stepId: string;
      stepKey: UserDeletionStepKey;
      claimToken: string;
    };

async function executeWaveItem(
  item: WaveItem,
  handlerDeadlineAt: number
): Promise<WaveItemExecution> {
  try {
    if (item.kind === 'preflight') {
      const result = await runDeletionPreflight(item.requestId);
      return {
        kind: 'durable',
        applied: result.kind !== 'skipped' || result.reason === 'already_blocked',
      };
    }
    const result = await runClaimedDeletionTask({
      stepId: item.stepId,
      claimToken: item.claimToken,
      deadlineAt: handlerDeadlineAt,
    });
    return {
      kind: 'durable',
      applied: result.kind === 'applied' || result.kind === 'already_terminal',
    };
  } catch (error) {
    captureException(error, {
      tags: { source: 'user-deletion-worker' },
      extra: {
        requestId: item.requestId,
        waveItemKind: item.kind,
        stepId: item.kind === 'task' ? item.stepId : undefined,
        stepKey: item.kind === 'task' ? item.stepKey : undefined,
      },
    });
    try {
      const failurePersisted =
        item.kind === 'preflight'
          ? await persistRejectedPreflight(item.requestId)
          : (
              await persistHandlerOutcome({
                requestId: item.requestId,
                stepKey: item.stepKey,
                claimToken: item.claimToken,
                outcome: {
                  kind: 'retry',
                  errorCode: 'worker_item_rejected',
                  httpStatusClass: 'error',
                },
                handlerDeadlineAt,
              })
            ).kind === 'applied';
      return { kind: 'failed', failurePersisted };
    } catch (persistError) {
      captureException(persistError, {
        tags: { source: 'user-deletion-worker' },
        extra: {
          requestId: item.requestId,
          waveItemKind: item.kind,
          stepId: item.kind === 'task' ? item.stepId : undefined,
          stepKey: item.kind === 'task' ? item.stepKey : undefined,
          fallbackPersistence: true,
        },
      });
      return { kind: 'failed', failurePersisted: false };
    }
  }
}

export async function buildDeletionWave(deadlineAt: number): Promise<WaveItem[]> {
  const wave: WaveItem[] = [];
  const usedRequestIds: string[] = [];
  const usedStepKeys: UserDeletionStepKey[] = [];

  while (wave.length < USER_DELETION_MAX_CONCURRENT_TASKS) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < USER_DELETION_STOP_STARTING_RESERVE_MS) break;

    const request = await selectEligibleDeletionRequest({
      excludeRequestIds: usedRequestIds,
    });
    if (!request) {
      if (wave.length === 1) {
        const same = await selectTaskItem(wave[0].requestId, remainingMs, usedStepKeys);
        if (same) {
          wave.push(same);
          usedStepKeys.push(same.stepKey);
        }
      }
      break;
    }

    if (request.status === 'pending') {
      wave.push({ kind: 'preflight', requestId: request.id });
      usedRequestIds.push(request.id);
      continue;
    }

    const task = await selectTaskItem(request.id, remainingMs, usedStepKeys);
    if (!task) {
      usedRequestIds.push(request.id);
      continue;
    }
    wave.push(task);
    usedRequestIds.push(request.id);
    usedStepKeys.push(task.stepKey);
  }

  return wave;
}

async function selectTaskItem(
  requestId: string,
  remainingMs: number,
  excludeStepKeys: readonly UserDeletionStepKey[]
): Promise<Extract<WaveItem, { kind: 'task' }> | null> {
  const claimed = await claimNextTaskForRequest({
    requestId,
    remainingMs,
    leaseMs: USER_DELETION_TASK_LEASE_MS,
    excludeStepKeys,
  });
  if (!claimed) return null;
  return {
    kind: 'task',
    requestId,
    stepId: claimed.step.id,
    stepKey: claimed.step.step_key,
    claimToken: claimed.claimToken,
  };
}
