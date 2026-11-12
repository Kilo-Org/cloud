export type WorkerDestroyResponse = {
  ok: true;
  finalized: boolean;
  destroyedUserId: string | null;
  destroyedSandboxId: string | null;
  pendingMachineId: string | null;
  pendingVolumeId: string | null;
  lastDestroyErrorOp: 'machine' | 'volume' | 'recover' | null;
  lastDestroyErrorStatus: number | null;
  lastDestroyErrorAt: number | null;
};

export type BulkDestroyBillingOutcome =
  | { status: 'canceled'; subscriptionIds: string[] }
  | { status: 'not_needed' }
  | { status: 'failed'; error: string };

export type BulkDestroyTarget = {
  id: string;
  userId: string;
  workerInstanceId?: string;
  destroyedAt: string | null;
};

export type BulkDestroyTargetResult =
  | { status: 'destroyed' }
  | { status: 'pending' }
  | { status: 'skipped'; reason: 'already_destroyed' }
  | { status: 'failed'; error: string };

export async function destroyBulkTarget(params: {
  target: BulkDestroyTarget;
  cancelHosting: () => Promise<BulkDestroyBillingOutcome>;
  markDestroyed: () => Promise<boolean>;
  restoreDestroyed: () => Promise<void>;
  destroyWorker: () => Promise<WorkerDestroyResponse>;
  isAlreadyGone: (error: unknown) => boolean;
  cleanup: () => Promise<void>;
}): Promise<{ billing: BulkDestroyBillingOutcome; result: BulkDestroyTargetResult }> {
  let billing: BulkDestroyBillingOutcome;
  try {
    billing = await params.cancelHosting();
  } catch (error) {
    billing = { status: 'failed', error: errorMessage(error, 'hosting cancellation failed') };
  }

  if (billing.status === 'failed') {
    return { billing, result: { status: 'failed', error: billing.error } };
  }

  const isRetry = params.target.destroyedAt !== null;
  if (isRetry && params.target.workerInstanceId !== params.target.id) {
    return {
      billing,
      result: { status: 'failed', error: 'legacy_destroy_retry_requires_manual_review' },
    };
  }

  let marked = false;
  if (!isRetry) {
    try {
      marked = await params.markDestroyed();
    } catch (error) {
      return {
        billing,
        result: { status: 'failed', error: errorMessage(error, 'failed to mark destroyed') },
      };
    }
    if (!marked) {
      return { billing, result: { status: 'failed', error: 'instance_destroy_state_changed' } };
    }
  }

  let finalized: boolean;
  try {
    const workerResult = await params.destroyWorker();
    if (workerResult?.ok !== true || typeof workerResult.finalized !== 'boolean') {
      throw new Error('Worker did not confirm destruction state');
    }
    finalized = workerResult.finalized;
  } catch (error) {
    if (
      isRetry &&
      params.target.workerInstanceId === params.target.id &&
      params.isAlreadyGone(error)
    ) {
      finalized = true;
    } else {
      if (marked) {
        try {
          await params.restoreDestroyed();
        } catch (restoreError) {
          return {
            billing,
            result: {
              status: 'failed',
              error: `${errorMessage(error, 'destroy failed')}; rollback failed: ${errorMessage(restoreError, 'unknown error')}`,
            },
          };
        }
      }
      return {
        billing,
        result: { status: 'failed', error: errorMessage(error, 'destroy failed') },
      };
    }
  }

  if (!finalized) {
    return { billing, result: { status: 'pending' } };
  }

  try {
    await params.cleanup();
  } catch (error) {
    return {
      billing,
      result: { status: 'failed', error: errorMessage(error, 'post-destroy cleanup failed') },
    };
  }

  return {
    billing,
    result: isRetry ? { status: 'skipped', reason: 'already_destroyed' } : { status: 'destroyed' },
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
