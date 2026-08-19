import { INTERNAL_API_SECRET, KILOCLAW_API_URL } from '@/lib/config.server';
import {
  listAllActiveInstanceRows,
  markActiveInstanceBatchDestroyedForGdpr,
  restoreGdprDestroyedInstanceBatch,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { KiloClawApiError, KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { USER_DELETION_RESOURCE_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import { classifyHttpStatus } from '@/lib/user/deletion-queue/deletion-http';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import type { DeletionHandlerOutcome } from '@/lib/user/deletion-queue/deletion-types';
import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import {
  configurationMissing,
  continueIfLowTime,
  incrementProcessed,
  providerAbortSignal,
  resourceHmac,
} from '@/lib/user/deletion-queue/handlers/common';

const GDPR_OWNERSHIP_MISMATCH_MESSAGE =
  'GDPR instance batch did not match the exact active user-owned ID set';
const GDPR_EMPTY_BATCH_MESSAGE = 'GDPR instance batch must include at least one instance ID';

export function classifyKiloclawMarkError(
  error: unknown,
  instanceResourceHmac: string
): DeletionHandlerOutcome {
  const message = error instanceof Error ? error.message : undefined;
  if (message === GDPR_OWNERSHIP_MISMATCH_MESSAGE || message === GDPR_EMPTY_BATCH_MESSAGE) {
    return {
      kind: 'needs_attention',
      errorCode: 'ownership_mismatch',
      resourceHmac: instanceResourceHmac,
    };
  }
  return { kind: 'retry', errorCode: 'kiloclaw_mark_failed', httpStatusClass: 'error' };
}

export const handleKiloclawDestroy: DeletionHandler = async ({ request, step, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  if (!KILOCLAW_API_URL || !INTERNAL_API_SECRET) {
    return configurationMissing();
  }

  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const live = await listAllActiveInstanceRows(userId);
  const batch = live.slice(0, USER_DELETION_RESOURCE_BATCH_SIZE);
  const startedEmpty = (step.progress_json.processed_count ?? 0) === 0 && live.length === 0;
  if (batch.length === 0) {
    return startedEmpty
      ? { kind: 'not_applicable' }
      : { kind: 'succeeded', progress: step.progress_json };
  }

  const client = new KiloClawInternalClient();
  let progress = step.progress_json;

  for (const instance of batch) {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    let marked;
    try {
      marked = await markActiveInstanceBatchDestroyedForGdpr(userId, [instance.id]);
    } catch (error) {
      return classifyKiloclawMarkError(error, resourceHmac(instance.id));
    }

    try {
      await client.destroy(userId, workerInstanceId(instance), {
        reason: 'admin_request',
        signal: providerAbortSignal(context),
      });
    } catch (error) {
      if (error instanceof KiloClawApiError && error.statusCode === 404) {
        progress = incrementProcessed(progress);
        continue;
      }
      try {
        await restoreGdprDestroyedInstanceBatch(marked);
      } catch {
        return {
          kind: 'needs_attention',
          errorCode: 'kiloclaw_rollback_failed',
          resourceHmac: resourceHmac(instance.id),
        };
      }
      if (error instanceof KiloClawApiError) {
        return error.statusCode === 429
          ? { kind: 'rate_limited', retryAfterMs: 60_000 }
          : classifyHttpStatus(error.statusCode);
      }
      return { kind: 'retry', errorCode: 'kiloclaw_destroy_failed', httpStatusClass: 'error' };
    }

    progress = incrementProcessed(progress);
  }

  const remaining = await listAllActiveInstanceRows(userId);
  if (remaining.length > 0) {
    return { kind: 'continue', progress };
  }
  return { kind: 'succeeded', progress };
};
