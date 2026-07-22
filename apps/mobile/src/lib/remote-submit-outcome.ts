import { type KiloSessionId } from 'cloud-agent-sdk';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type CreateSessionOutcome } from '@/lib/hooks/use-remote-instance-spawn';

/**
 * The fixed string copy surfaced in the toast when the spawn hook returns
 * a `retryable` outcome. The phrasing is intentionally a soft
 * "may have disconnected" hint: the actual cause is opaque (transport
 * timeout, destroyed socket, or the DO's `Session owner not found`
 * literal) and the recovery path is the same — refetch the instance
 * list and re-evaluate.
 */
export const REMOTE_SPAWN_RETRYABLE_TOAST =
  'Couldn’t reach the instance — it may have disconnected.';

/**
 * The fixed string copy surfaced in the toast when the spawn hook returns
 * a `nonRetryable` outcome. Distinct from the retryable case so the user
 * understands the situation is not a transient network blip: the CLI
 * refused the spawn for a structural reason (malformed envelope,
 * `CLI_UPGRADE_REQUIRED`, etc.).
 */
export const REMOTE_SPAWN_NON_RETRYABLE_TOAST =
  'The instance failed to start the session — check the machine or update the CLI.';

/**
 * Inline note shown under the "Run on" selector when a retryable spawn
 * failure left the previously-selected `connectionId` no longer present
 * in the refetched list. The selector itself has fallen back to
 * "Cloud Agent" (the `null` value), so the note explains why the
 * selection changed.
 */
export const REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE =
  'The selected instance disconnected. Start a session on Cloud Agent or pick another instance.';

export type RemoteSubmitOutcomeAction =
  | {
      kind: 'navigate';
      /**
       * The `KiloSessionId` of the freshly-spawned session. Caller
       * navigates through `getSpawnedAgentSessionPath` so the
       * `spawned=1` readiness retry kicks in.
       */
      sessionID: KiloSessionId;
    }
  | {
      kind: 'retryable';
      toast: string;
      /**
       * The caller must refetch the instance list (the same
       * `activeSessions.listInstances` query powering the selector)
       * before re-evaluating `runOnInstance`. Always `true` for the
       * retryable branch — the whole point of this case is "the
       * instance may have just disconnected, ask the server again".
       */
      shouldRefetchInstances: true;
      /**
       * When `true`, the caller should clear `runOnInstance` because
       * the previously-selected `connectionId` is no longer in the
       * refetched list. The caller computes this against the
       * refetched list; we pre-compute the answer here so the
       * consumer is a single dispatch (no double-check at the call
       * site, no risk of disagreement between the toast copy and
       * the reset).
       */
      shouldResetSelectionToCloudAgent: boolean;
      /**
       * Tied to `shouldResetSelectionToCloudAgent`: the inline
       * "disconnected" note under the selector only appears when we
       * actually moved the selection away. Re-asserted here so a
       * caller that wants to display the note independently (e.g.
       * an analytics event) doesn't have to duplicate the
       * membership check.
       */
      showInstanceDisconnectedNote: boolean;
    }
  | {
      kind: 'nonRetryable';
      toast: string;
      /**
       * Caller must NOT navigate, refetch, or reset the selection.
       * The existing "Start session" button is the only re-entry
       * affordance, matching the plan's non-retryable UX matrix.
       */
    };
/**
 * Pure: map a `CreateSessionOutcome` (already classified by
 * `useRemoteInstanceSpawn`) to the exact UX actions the new-agent
 * screen must dispatch. The caller is responsible for the side
 * effects (toast, `refetch()`, `setRunOnInstance(null)`,
 * `router.replace`).
 *
 * The membership check (`is the previously-selected connectionId
 * still in the refetched list?`) runs HERE, against the
 * `selectedConnectionId` + `refetchedInstances` pair the caller hands
 * in. That's the only place that knows both — the hook's
 * `CreateSessionOutcome` does not carry the connectionId (it carries
 * the per-spawner `creationKey`, which is a different opaque
 * identifier). Keeping the check in this helper means the contract
 * is testable in plain Node and the call site is a single dispatch.
 *
 * On `ready` / `nonRetryable` the membership inputs are ignored.
 */
export function resolveRemoteSubmitOutcome({
  outcome,
  refetchedInstances,
  selectedConnectionId,
}: {
  outcome: CreateSessionOutcome;
  refetchedInstances: InstancePickerInstance[];
  /**
   * The `connectionId` of the instance the user had selected at the
   * moment the spawn call started. Required for the retryable
   * branch (where we use it to decide whether to reset
   * `runOnInstance` to `null`); ignored for `ready` /
   * `nonRetryable`.
   */
  selectedConnectionId: string | null;
}): RemoteSubmitOutcomeAction {
  if (outcome.status === 'ready') {
    return { kind: 'navigate', sessionID: outcome.sessionID };
  }
  if (outcome.status === 'nonRetryable') {
    return { kind: 'nonRetryable', toast: REMOTE_SPAWN_NON_RETRYABLE_TOAST };
  }
  // outcome.status === 'retryable'
  const stillPresent =
    selectedConnectionId !== null &&
    refetchedInstances.some(instance => instance.connectionId === selectedConnectionId);
  const shouldReset = !stillPresent;
  return {
    kind: 'retryable',
    toast: REMOTE_SPAWN_RETRYABLE_TOAST,
    shouldRefetchInstances: true,
    shouldResetSelectionToCloudAgent: shouldReset,
    showInstanceDisconnectedNote: shouldReset,
  };
}
