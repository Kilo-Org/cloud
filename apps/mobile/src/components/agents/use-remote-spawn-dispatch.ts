import { useCallback, useEffect, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { toast } from 'sonner-native';
import { type ModelSelection } from '@kilocode/cloud-agent-sdk';

import { getSpawnedAgentSessionPath } from '@/components/agents/session-detail-routes';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  buildCreateRemoteSessionInput,
  type CreateRemoteSessionInput,
  type CreateSessionOutcome,
  type CreateSessionSpawnOptions,
  type RemoteInstanceSpawnStatus,
  useRemoteInstanceSpawn,
} from '@/lib/hooks/use-remote-instance-spawn';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  REMOTE_SPAWN_NON_RETRYABLE_TOAST,
  REMOTE_SPAWN_RETRYABLE_TOAST,
  resolveRemoteSubmitOutcome,
} from '@/lib/remote-submit-outcome';
import { resolveRemoteSpawnAdmission } from '@/lib/remote-spawn-admission';
import { putSharePayload, type SharePayload } from '@/lib/share-payload';
import { appendShareParams } from '@/lib/share-navigation';

/**
 * Refetch signature matching the slice of
 * `useQuery(...).refetch()` we need: returns the new data on
 * success, throws on failure. We type it narrowly so this hook
 * stays a thin wrapper without dragging TanStack Query types into
 * the call site.
 */
type InstancesRefetch = () => Promise<{
  data: { instances: InstancePickerInstance[] } | undefined;
}>;

type UseRemoteSpawnDispatchArgs = {
  organizationId: string | undefined;
  /**
   * The current new-session agent mode for the spawn target. Omitted for
   * callers without a mode (share-gate); the CLI then uses its default.
   */
  mode?: string;
  /**
   * The validated wire model selection for the active target. Never inherited:
   * the caller owns it because it depends on the target instance's catalog.
   * Undefined means "let the CLI use its default".
   */
  selection?: ModelSelection;
  runOnInstance: InstancePickerInstance | null;
  setRunOnInstance: (next: InstancePickerInstance | null) => void;
  /**
   * Existing `activeSessions.listInstances` query's `refetch`. The
   * route already owns this query (it's what powers the selector's
   * `instanceList`); we reuse it here so a retryable spawn failure
   * refreshes the same source of truth the picker reads from.
   */
  refetchInstances: InstancesRefetch;
  /**
   * The most recent list the route knows about. Used as the
   * membership fallback if the refetch fails.
   */
  instanceList: InstancePickerInstance[];
  /**
   * Snapshot of the composer, read once at press time. When it returns a
   * payload the ready path stages it, and the destination composer submits it
   * once. Optional: a caller with no composer omits it.
   */
  getSubmitPayload?: () => SharePayload | null;
  /**
   * Invoked when `onStart` admits the press-time snapshot and commits to a
   * spawn attempt: the caller already passed voice settlement (it only calls
   * `onStart` after the voice input settled) and `resolveRemoteSpawnAdmission`
   * allowed the payload. A tap that never reaches a spawn — blocked
   * admission, cancelled voice submit, or a `null` selection — never fires
   * this, so callers can arm draft clearing on exactly the attempts that
   * happened.
   */
  onSpawnAdmitted?: () => void;
};

type UseRemoteSpawnDispatchResult = {
  /**
   * `true` while the spawn hook has a request in flight. Mirrors
   * `remoteSpawn.status.status === 'inFlight'`, surfaced for the
   * route's "is the start button disabled?" check.
   */
  isSpawningRemote: boolean;
  /**
   * `true` after a retryable spawn failure reset the selection
   * because the previously-selected `connectionId` dropped off the
   * refetched list. Drives the inline "disconnected" note under
   * the selector.
   */
  showInstanceDisconnectedNote: boolean;
  /**
   * `onStart` for the route's "Start session" CTA when a remote
   * target is selected. No-op when the selection is `null` (the
   * route should have routed the cloud-agent path through
   * `submitCreate` instead, but the guard is defensive). Fires
   * `onSpawnAdmitted` only once a spawn attempt is actually
   * committed to (voice settlement + admission passed).
   */
  onStart: () => void;
  /**
   * Called by the "Run on" selector when the user picks a new
   * instance or switches back to Cloud Agent. Clears the inline
   * "disconnected" note — the note is only meaningful while the
   * selector is on the post-fallback default.
   */
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
};

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
  getSubmitPayload,
  onSpawnAdmitted,
}: UseRemoteSpawnDispatchArgs): UseRemoteSpawnDispatchResult {
  const router = useRouter();
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
  const runOnInstanceRef = useRef(runOnInstance);
  useEffect(() => {
    runOnInstanceRef.current = runOnInstance;
  }, [runOnInstance]);

  // Read the press-time inputs through refs so `onStart` stays stable across
  // renders while always seeing the route's latest values.
  const getSubmitPayloadRef = useRef(getSubmitPayload);
  const spawnFieldsRef = useRef({ mode, selection, organizationId });
  const onSpawnAdmittedRef = useRef(onSpawnAdmitted);
  useEffect(() => {
    getSubmitPayloadRef.current = getSubmitPayload;
    spawnFieldsRef.current = { mode, selection, organizationId };
    onSpawnAdmittedRef.current = onSpawnAdmitted;
  }, [getSubmitPayload, mode, selection, organizationId, onSpawnAdmitted]);

  const onStart = useCallback(() => {
    if (runOnInstance === null) {
      return;
    }
    const selectedConnectionId = runOnInstance.connectionId;
    const fields = spawnFieldsRef.current;
    // Press-time snapshot. Read once, here, before any await.
    const submitPayload = getSubmitPayloadRef.current?.() ?? null;
    const admission = resolveRemoteSpawnAdmission({
      instance: runOnInstance,
      payload: submitPayload,
    });
    if (!admission.allowed) {
      toast.error(admission.toast);
      return;
    }
    // Admission passed and voice settlement already happened at the caller:
    // commit to the spawn attempt. The route arms its draft-clearing marker
    // here, so a tap that stops at admission can never clear the draft.
    onSpawnAdmittedRef.current?.();
    const createInput = buildCreateRemoteSessionInput({
      mode: fields.mode,
      selection: fields.selection,
      organizationId: fields.organizationId,
    });
    const operationKey = getKey(
      JSON.stringify({
        connectionId: selectedConnectionId,
        mode: fields.mode,
        selection: fields.selection,
        organizationId: fields.organizationId,
      })
    );
    void (async () => {
      const outcome = await remoteSpawn.spawn(selectedConnectionId, createInput, { operationKey });
      if (outcome.status === 'ready') {
        // The spawn settled; the next submit is a fresh intent.
        rotateKey();
        const spawnedPath = getSpawnedAgentSessionPath(outcome.sessionID, organizationId);
        if (submitPayload === null) {
          router.replace(spawnedPath);
          return;
        }
        const shareId = putSharePayload(submitPayload);
        router.replace(
          appendShareParams(spawnedPath as string, shareId, { autoSend: true }) as Href
        );
        return;
      }
      if (outcome.status === 'nonRetryable') {
        // A typed non-retryable rejection ends the intent.
        rotateKey();
        toast.error(REMOTE_SPAWN_NON_RETRYABLE_TOAST);
        return;
      }
      // outcome.status === 'retryable': refetch the instance list and
      // re-evaluate whether the previously-selected instance is still
      // present.
      toast.error(REMOTE_SPAWN_RETRYABLE_TOAST);
      let refetchedInstances: InstancePickerInstance[] = instanceList;
      try {
        const result = await refetchInstances();
        refetchedInstances = result.data?.instances ?? instanceList;
      } catch {
        // Refetch failed; fall through with the last-known list. The
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
    })();
  }, [
    instanceList,
    organizationId,
    refetchInstances,
    remoteSpawn,
    router,
    runOnInstance,
    setRunOnInstance,
    getKey,
    rotateKey,
  ]);

  const onChangeRunOnInstance = useCallback(
    (next: InstancePickerInstance | null) => {
      setRunOnInstance(next);
      if (showInstanceDisconnectedNote) {
        setShowInstanceDisconnectedNote(false);
      }
    },
    [setRunOnInstance, showInstanceDisconnectedNote]
  );

  return {
    isSpawningRemote: remoteSpawn.status.status === 'inFlight',
    showInstanceDisconnectedNote,
    onStart,
    onChangeRunOnInstance,
  };
}
