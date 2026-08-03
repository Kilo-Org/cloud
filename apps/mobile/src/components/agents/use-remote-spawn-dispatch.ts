import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'expo-router';
import { toast } from 'sonner-native';

import { getSpawnedAgentSessionPath } from '@/components/agents/session-detail-routes';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  buildCreateRemoteSessionInput,
  type CreateRemoteSessionInput,
  type CreateSessionOutcome,
  type RemoteInstanceSpawnStatus,
  useRemoteInstanceSpawn,
} from '@/lib/hooks/use-remote-instance-spawn';
import {
  REMOTE_SPAWN_NON_RETRYABLE_TOAST,
  REMOTE_SPAWN_RETRYABLE_TOAST,
  resolveRemoteSubmitOutcome,
} from '@/lib/remote-submit-outcome';

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

type RemoteSpawnInheritance = {
  mode?: string;
  model?: string;
  variant?: string;
};

const RemoteSpawnInheritanceContext = createContext<RemoteSpawnInheritance>({});

/**
 * Supplies the new-session screen's current mode/model/variant to
 * `useRemoteSpawnDispatch` without requiring the sibling-owned
 * `use-new-session-share-remote` wrapper to forward those fields.
 */
export function RemoteSpawnInheritanceProvider({
  mode,
  model,
  variant,
  children,
}: RemoteSpawnInheritance & { children: ReactNode }) {
  const value = useMemo(() => ({ mode, model, variant }), [mode, model, variant]);
  return createElement(RemoteSpawnInheritanceContext.Provider, { value }, children);
}

type UseRemoteSpawnDispatchArgs = {
  organizationId: string | undefined;
  /**
   * Optional override for inheritance fields. When omitted, values come from
   * the nearest `RemoteSpawnInheritanceProvider` (the new-session screen).
   */
  mode?: string;
  model?: string;
  variant?: string;
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
   * When true on a ready outcome, skip `router.replace` so a share that
   * arrived mid-spawn is not stranded by navigating away. Optional —
   * only the new-session route passes this today.
   */
  shouldCancelReadyNavigation?: () => boolean;
  /** Called when ready navigation is cancelled by `shouldCancelReadyNavigation`. */
  onReadyNavigationCancelled?: () => void;
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
   * `submitCreate` instead, but the guard is defensive).
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
  mode: modeArg,
  model: modelArg,
  variant: variantArg,
  runOnInstance,
  setRunOnInstance,
  refetchInstances,
  instanceList,
  shouldCancelReadyNavigation,
  onReadyNavigationCancelled,
}: UseRemoteSpawnDispatchArgs): UseRemoteSpawnDispatchResult {
  const router = useRouter();
  const inheritance = useContext(RemoteSpawnInheritanceContext);
  const mode = modeArg ?? inheritance.mode;
  const model = modelArg ?? inheritance.model;
  const variant = variantArg ?? inheritance.variant;
  // Route param is frozen at navigation: missing param means personal, not
  // "inherit live context". `?? null` so undefined does not fall through to
  // `useOrganization()` after a later org switch (share-gate keeps zero-arg
  // inherit by calling `useRemoteInstanceSpawn()` with no arg).
  const remoteSpawn: {
    status: RemoteInstanceSpawnStatus;
    spawn: (connectionId: string, opts?: CreateRemoteSessionInput) => Promise<CreateSessionOutcome>;
  } = useRemoteInstanceSpawn(organizationId ?? null);
  const [showInstanceDisconnectedNote, setShowInstanceDisconnectedNote] = useState(false);

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

  // Same lifetime concern as runOnInstanceRef: the cancel predicate and
  // cancelled callback must be read at ready-time, not captured from the
  // render that started the spawn. Mode/model/variant likewise — spawn
  // should use the values at press time, but the ref keeps them current
  // if the parent re-renders mid-flight before spawn is invoked.
  const shouldCancelReadyNavigationRef = useRef(shouldCancelReadyNavigation);
  const onReadyNavigationCancelledRef = useRef(onReadyNavigationCancelled);
  const spawnFieldsRef = useRef({ mode, model, variant, organizationId });
  useEffect(() => {
    shouldCancelReadyNavigationRef.current = shouldCancelReadyNavigation;
    onReadyNavigationCancelledRef.current = onReadyNavigationCancelled;
    spawnFieldsRef.current = { mode, model, variant, organizationId };
  }, [
    shouldCancelReadyNavigation,
    onReadyNavigationCancelled,
    mode,
    model,
    variant,
    organizationId,
  ]);

  const onStart = useCallback(() => {
    if (runOnInstance === null) {
      return;
    }
    const selectedConnectionId = runOnInstance.connectionId;
    const fields = spawnFieldsRef.current;
    const createInput = buildCreateRemoteSessionInput({
      mode: fields.mode,
      model: fields.model,
      variant: fields.variant,
      organizationId: fields.organizationId,
    });
    void (async () => {
      const outcome = await remoteSpawn.spawn(selectedConnectionId, createInput);
      if (outcome.status === 'ready') {
        if (shouldCancelReadyNavigationRef.current?.() === true) {
          // Cancel contract: toast via callback, then leave the user on the
          // cloud composer — not on RemoteSpawnComposer with a live selection.
          onReadyNavigationCancelledRef.current?.();
          setRunOnInstance(null);
          return;
        }
        router.replace(getSpawnedAgentSessionPath(outcome.sessionID, organizationId));
        return;
      }
      if (outcome.status === 'nonRetryable') {
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
