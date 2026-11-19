import { type CreateSessionOutcome } from '@/lib/hooks/use-remote-instance-spawn';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { resolveRemoteSubmitOutcome } from '@/lib/remote-submit-outcome';

import { type UseRemoteSpawnDispatchArgs } from './use-remote-spawn-dispatch-types';

/**
 * Refetch the live instance list, falling back to the last-known list when
 * the refetch throws. A network blip must not look like "the host
 * disconnected": the caller re-evaluates its selection against whatever list
 * it can still trust.
 */
export async function refetchInstanceList(
  refetchInstances: UseRemoteSpawnDispatchArgs['refetchInstances'],
  fallback: InstancePickerInstance[]
): Promise<InstancePickerInstance[]> {
  try {
    const result = await refetchInstances();
    return result.data?.instances ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The selection action a `retryable` spawn outcome asks for, resolved against
 * a freshly refetched instance list. `null` means the outcome produced no
 * retryable action, so the caller must leave the selection alone.
 */
export type RetryableSettlement = {
  shouldResetSelectionToCloudAgent: boolean;
  showInstanceDisconnectedNote: boolean;
};

/**
 * Settle a `retryable` outcome: refetch, then ask the pure outcome mapping
 * whether the previously-selected `connectionId` survived. The spawn remaps
 * the selection to a live row, so this seeds from the fresh pre-spawn list
 * rather than the press-time one: a post-spawn refetch throw would otherwise
 * make the live id look missing and reset the selection to Cloud Agent even
 * though the host is live.
 */
export async function resolveRetryableSettlement({
  outcome,
  refreshFrom,
  selectedConnectionId,
  refetchInstances,
}: {
  outcome: CreateSessionOutcome;
  refreshFrom: InstancePickerInstance[];
  selectedConnectionId: string;
  refetchInstances: UseRemoteSpawnDispatchArgs['refetchInstances'];
}): Promise<RetryableSettlement | null> {
  const refetchedInstances = await refetchInstanceList(refetchInstances, refreshFrom);
  const action = resolveRemoteSubmitOutcome({
    outcome,
    refetchedInstances,
    selectedConnectionId,
  });
  if (action.kind !== 'retryable') {
    // Defensive: a retryable outcome must produce a retryable action. If this
    // ever changes we'll want to know.
    return null;
  }
  return {
    shouldResetSelectionToCloudAgent: action.shouldResetSelectionToCloudAgent,
    showInstanceDisconnectedNote: action.showInstanceDisconnectedNote,
  };
}
