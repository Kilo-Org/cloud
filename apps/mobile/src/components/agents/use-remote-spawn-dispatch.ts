import { useCallback, useState } from 'react';
import { type Href } from 'expo-router';

import {
  type RemoteSpawnFailure,
  type UseRemoteSpawnDispatchArgs,
  type UseRemoteSpawnDispatchResult,
} from './use-remote-spawn-dispatch-types';
import { useAttemptWatchdog } from './use-attempt-watchdog';
import { useLatestRef } from './use-latest-ref';
import { getSpawnedAgentSessionPath } from '@/components/agents/session-detail-routes';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  buildCreateRemoteSessionInput,
  type CreateRemoteSessionInput,
  type CreateSessionOutcome,
  type CreateSessionSpawnOptions,
  type RemoteInstanceSpawnStatus,
  useRemoteInstanceSpawn,
} from '@/lib/hooks/use-remote-instance-spawn';
import {
  resolveCloneCapabilityRefusal,
  resolveCloneImportFailure,
} from '@/lib/hooks/remote-instance-spawn-classifier';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { resolveLiveInstance } from '@/lib/resolve-live-instance';
import {
  remoteSpawnRetryableToast,
  resolveRemoteSpawnFailure,
  resolveRemoteSubmitOutcome,
} from '@/lib/remote-submit-outcome';
import { resolveRemoteSpawnAdmission } from '@/lib/remote-spawn-admission';
import { withComposerHandoff } from '@/lib/share-navigation';

export type { RemoteSpawnFailure, UseRemoteSpawnDispatchArgs, UseRemoteSpawnDispatchResult };

/**
 * Budget for a remote spawn attempt to settle before the form stops showing
 * the busy button and offers the retry. Matches the SDK's own command
 * timeout (`COMMAND_TIMEOUT_MS` in `@kilocode/cloud-agent-sdk`), so the
 * watchdog fires only once the transport timeout has also run out.
 */
export const REMOTE_SPAWN_START_DEADLINE_MS = 30_000;

/**
 * Wires `useRemoteInstanceSpawn` into the route's existing state and
 * tRPC query so a remote-target submit becomes a single
 * `onStart()` dispatch:
 *
 *   - `ready`         -> `router.replace` via `getSpawnedAgentSessionPath`
 *   - `retryable`     -> toast + refetch the instance list + reset the
 *                        selection to `null` if the selected
 *                        `connectionId` dropped off
 *   - `nonRetryable`  -> toast, no navigation, no refetch
 *
 * The outcome -> action mapping is in
 * `@/lib/remote-submit-outcome` (pure, unit-tested). This hook is
 * pure glue: it owns no product logic beyond the dispatch itself.
 */
export function useRemoteSpawnDispatch({
  organizationId,
  mode,
  selection,
  runOnInstance,
  setRunOnInstance,
  refetchInstances,
  instanceList,
  directory,
  getSubmitPayload,
  cloneFromKiloSessionId,
  cloneUpToMessageId,
  forkPrefillText,
  onCloneImportFailure,
  onSpawnAdmitted,
  onSpawnFailed,
  onSpawnReady,
  onSpawnSucceeded,
}: UseRemoteSpawnDispatchArgs): UseRemoteSpawnDispatchResult {
  const router = useStackSafeReplace();
  // Route param is frozen at navigation: missing param means personal, not
  // "inherit live context". `?? null` so undefined does not fall through to
  // `useOrganization()` after a later org switch (share-gate keeps zero-arg
  // inherit by calling `useRemoteInstanceSpawn()` with no arg).
  const remoteSpawn: {
    status: RemoteInstanceSpawnStatus;
    spawn: (
      connectionId: string,
      opts?: CreateRemoteSessionInput,
      options?: CreateSessionSpawnOptions
    ) => Promise<CreateSessionOutcome>;
  } = useRemoteInstanceSpawn(organizationId ?? null);
  const [showInstanceDisconnectedNote, setShowInstanceDisconnectedNote] = useState(false);
  // The spawn's inline-rendered failure; the dispatch does not toast it.
  const [remoteSpawnFailure, setRemoteSpawnFailure] = useState<RemoteSpawnFailure | null>(null);
  // `true` only while the pre-spawn window is open: the instance refetch, the
  // live resolution, and the spawn itself. The post-failure refetch runs
  // outside this flag so the button releases at the outcome.
  const [isResolvingInstance, setIsResolvingInstance] = useState(false);
  // Watchdog for the whole admitted attempt: when the spawn outlives the SDK
  // command timeout, `timedOut` releases the button (the spawn hook's
  // inFlight status no longer holds it busy) and the form flips to the
  // inline retryable failure; a late success still navigates.
  const spawnWatchdog = useAttemptWatchdog(REMOTE_SPAWN_START_DEADLINE_MS, () => {
    setIsResolvingInstance(false);
    setRemoteSpawnFailure({ retryable: true, message: remoteSpawnRetryableToast() });
    onSpawnFailedRef.current?.();
  });
  const { arm: armWatchdog, disarm: clearWatchdog } = spawnWatchdog;
  // P1-A-08b: one `operationKey` per spawn intent, so a retryable failure keeps
  // the key and the relay dedupes the retry.
  const { getKey, rotateKey } = useHoistedOperationKey();

  // kilocode_change - `onStart`'s async tail (spawn + refetch + classify)
  // outlives a single render; a plain closure over `runOnInstance` would
  // only ever see the value from the render that started this dispatch,
  // not whatever the user picks while it's still in flight (which can
  // happen: `isSpawningRemote` already flips back to `false` as soon as
  // `remoteSpawn.spawn()` resolves, well before the refetch+classify tail
  // finishes). A ref always reflects the latest selection so the tail can
  // check "is my selection still the current one?" against real current
  // state, not a stale snapshot.
  const runOnInstanceRef = useLatestRef(runOnInstance);

  // Read the press-time inputs through refs so `onStart` stays stable across
  // renders while always seeing the route's latest values.
  const getSubmitPayloadRef = useLatestRef(getSubmitPayload);
  const spawnFieldsRef = useLatestRef({
    mode,
    selection,
    organizationId,
    directory,
    cloneFromKiloSessionId,
    cloneUpToMessageId,
    forkPrefillText,
  });
  const onSpawnAdmittedRef = useLatestRef(onSpawnAdmitted);
  const onSpawnFailedRef = useLatestRef(onSpawnFailed);
  const onSpawnReadyRef = useLatestRef(onSpawnReady);
  const onCloneImportFailureRef = useLatestRef(onCloneImportFailure);
  const onSpawnSucceededRef = useLatestRef(onSpawnSucceeded);

  const onStart = useCallback(() => {
    if (runOnInstance === null) {
      return;
    }
    const fields = spawnFieldsRef.current;
    // Press-time snapshot. Read once, here, before any await.
    const submitPayload = getSubmitPayloadRef.current?.() ?? null;
    const admission = resolveRemoteSpawnAdmission({
      instance: runOnInstance,
      payload: submitPayload,
    });
    if (!admission.allowed) {
      setRemoteSpawnFailure({ retryable: false, message: admission.toast });
      return;
    }
    // Clone entry: a full clone is refused only by an explicit
    // `sessionClone: false`; a fork cut needs `sessionCloneAtMessage: true`.
    // Fail before spawn (and before admitting the attempt) so the route shows
    // the inline reason instead of firing a spawn the CLI rejects or mis-cuts.
    const cloneRefusal = resolveCloneCapabilityRefusal(fields, runOnInstance);
    if (cloneRefusal !== null) {
      onCloneImportFailureRef.current?.(cloneRefusal);
      return;
    }
    // Admission passed and voice settlement already happened at the caller:
    // commit to the spawn attempt. The route arms its draft-clearing marker
    // here, so a tap that stops at admission can never clear the draft.
    onSpawnAdmittedRef.current?.();
    // A fresh attempt replaces the previous failure with either the session
    // or the new failure state; the watchdog re-arms for it.
    setRemoteSpawnFailure(null);
    clearWatchdog();
    armWatchdog();
    const createInput = buildCreateRemoteSessionInput({
      mode: fields.mode,
      selection: fields.selection,
      organizationId: fields.organizationId,
      directory: fields.directory,
      cloneFromKiloSessionId: fields.cloneFromKiloSessionId,
      cloneUpToMessageId: fields.cloneUpToMessageId,
    });
    void (async () => {
      setIsResolvingInstance(true);
      // `settled` guards the watchdog race: after the deadline has flipped
      // the form to the inline failure, a late tail must not re-assert busy
      // state or overwrite the failure with a second report of the same
      // attempt.
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearWatchdog();
        setIsResolvingInstance(false);
      };
      try {
        // Refetch the live instance list so a rebooted host's new
        // connectionId replaces the stale selection before spawn.
        let freshList = instanceList;
        try {
          const result = await refetchInstances();
          freshList = result.data?.instances ?? instanceList;
        } catch {
          // Refetch failed; continue with the last-known list.
        }
        const live = resolveLiveInstance(runOnInstance, freshList);
        if (live === null) {
          // No live row matches the selection (neither the connectionId nor
          // the name + projectName pair). Surface the retryable copy and let
          // the next Start tap re-resolve against a refreshed list.
          settle();
          setRemoteSpawnFailure({ retryable: true, message: remoteSpawnRetryableToast() });
          onSpawnFailedRef.current?.();
          return;
        }
        // The live row can differ from the press-time row (a rebooted host
        // comes back on a new connectionId), and it can report an explicit
        // refusal the press-time row did not. Re-run both admission checks
        // against it, so a file payload or a clone source is never spawned on
        // an instance that now refuses it. The attempt was already admitted at
        // press time, so a refusal here fails it and re-arms the abandon guard.
        const liveAdmission = resolveRemoteSpawnAdmission({
          instance: live,
          payload: submitPayload,
        });
        if (!liveAdmission.allowed) {
          settle();
          setRemoteSpawnFailure({ retryable: false, message: liveAdmission.toast });
          onSpawnFailedRef.current?.();
          return;
        }
        const liveCloneRefusal = resolveCloneCapabilityRefusal(fields, live);
        if (liveCloneRefusal !== null) {
          settle();
          onCloneImportFailureRef.current?.(liveCloneRefusal);
          onSpawnFailedRef.current?.();
          return;
        }
        const selectedConnectionId = live.connectionId;
        // A rebooted host advertises the same name + projectName on a new
        // connectionId. Remap the selection to the live row so the spawn and
        // a later refetch agree. The unchanged-id case keeps the same id and
        // the same hoisted operation key.
        if (live.connectionId !== runOnInstance.connectionId) {
          setRunOnInstance(live);
        }
        const operationKey = getKey(
          JSON.stringify({
            connectionId: selectedConnectionId,
            mode: fields.mode,
            selection: fields.selection,
            organizationId: fields.organizationId,
            directory: fields.directory,
            // A different fork cut is a different intent, never a replay.
            cloneUpToMessageId: fields.cloneUpToMessageId ?? undefined,
          })
        );
        const outcome = await remoteSpawn.spawn(selectedConnectionId, createInput, {
          operationKey,
        });
        if (outcome.status === 'ready') {
          settle();
          // The spawn settled; the next submit is a fresh intent.
          rotateKey();
          const spawnedPath = getSpawnedAgentSessionPath(outcome.sessionID, organizationId, {
            cloned: Boolean(fields.cloneFromKiloSessionId),
          });
          // Arm the clone entry's busy leave-lock bypass right before the
          // success replace so the navigation is not intercepted as an abandon.
          onSpawnReadyRef.current?.();
          onSpawnSucceededRef.current?.(outcome.sessionID);
          router.replace(
            withComposerHandoff(spawnedPath as string, {
              submitPayload,
              forkPrefillText: fields.forkPrefillText,
              mode: fields.mode,
            }) as Href
          );
          return;
        }
        // Not ready: the spawn settled without navigating. Release the busy
        // button and re-arm the caller's abandon guard so a later back/swipe
        // still confirms.
        settle();
        onSpawnFailedRef.current?.();
        if (outcome.status === 'nonRetryable') {
          // A typed non-retryable rejection ends the intent.
          rotateKey();
          const cloneFailureKey = fields.cloneFromKiloSessionId
            ? resolveCloneImportFailure(outcome)
            : null;
          if (cloneFailureKey !== null) {
            // Delivered clone/import error: surface the inline reason under
            // "Run on" instead of the generic spawn failure.
            onCloneImportFailureRef.current?.(cloneFailureKey);
            return;
          }
        }
        // outcome.status === 'retryable': a clone/import retry keeps the form
        // and re-enables Start; the selection is never reset to Cloud Agent.
        if (outcome.status === 'retryable' && fields.cloneFromKiloSessionId) {
          setRemoteSpawnFailure({
            retryable: true,
            message: i18n.t('agentChat.session.cloneFailedRetry'),
          });
          return;
        }
        const failure = resolveRemoteSpawnFailure({ outcome });
        if (failure !== null) {
          setRemoteSpawnFailure(failure);
        }
        if (outcome.status !== 'retryable') {
          return;
        }
        // Seed from the fresh pre-spawn list, not the press-time
        // `instanceList`: if the spawn remapped the selection to a live
        // connectionId above, the press-time list still holds the stale id. A
        // post-spawn refetch throw would then make the live id look missing
        // and reset the selection to Cloud Agent even though the host is live.
        let refetchedInstances: InstancePickerInstance[] = freshList;
        try {
          const result = await refetchInstances();
          refetchedInstances = result.data?.instances ?? freshList;
        } catch {
          // Refetch failed; fall through with the fresh pre-spawn list. The
          // mapping helper treats an empty list as "disconnected", which
          // is the right conservative default for a network blip.
        }
        const action = resolveRemoteSubmitOutcome({
          outcome,
          refetchedInstances,
          selectedConnectionId,
        });
        if (action.kind !== 'retryable') {
          // Defensive: outcome.status === 'retryable' must produce a
          // retryable action. If this ever changes we'll want to know.
          return;
        }
        // kilocode_change - only apply the reset if the selection this
        // dispatch was FOR is still the CURRENT one (read from the ref, not
        // the closure-captured `runOnInstance` — see the ref's comment
        // above). Without this check, a stale tail's reset could clobber a
        // newer, unrelated selection the user already made.
        if (
          action.shouldResetSelectionToCloudAgent &&
          runOnInstanceRef.current?.connectionId === selectedConnectionId
        ) {
          setRunOnInstance(null);
          setShowInstanceDisconnectedNote(action.showInstanceDisconnectedNote);
        }
      } finally {
        // A tail that exits without an explicit settle (a thrown helper, a
        // defensive return) still releases the busy window; the watchdog
        // covers the hang case.
        settle();
      }
    })();
  }, [
    armWatchdog,
    clearWatchdog,
    getSubmitPayloadRef,
    instanceList,
    onCloneImportFailureRef,
    onSpawnAdmittedRef,
    onSpawnFailedRef,
    onSpawnReadyRef,
    onSpawnSucceededRef,
    organizationId,
    refetchInstances,
    remoteSpawn,
    router,
    runOnInstance,
    runOnInstanceRef,
    setRunOnInstance,
    spawnFieldsRef,
    getKey,
    rotateKey,
  ]);

  const onChangeRunOnInstance = useCallback(
    (next: InstancePickerInstance | null) => {
      setRunOnInstance(next);
      // A new target invalidates the previous attempt's failure.
      setRemoteSpawnFailure(null);
      if (showInstanceDisconnectedNote) {
        setShowInstanceDisconnectedNote(false);
      }
    },
    [setRunOnInstance, showInstanceDisconnectedNote]
  );

  return {
    isSpawningRemote:
      (remoteSpawn.status.status === 'inFlight' && !spawnWatchdog.timedOut) || isResolvingInstance,
    remoteSpawnFailure,
    showInstanceDisconnectedNote,
    onStart,
    onChangeRunOnInstance,
  };
}
