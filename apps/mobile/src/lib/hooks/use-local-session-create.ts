import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { captureEvent } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { trpcClient, useTRPC } from '@/lib/trpc';

import { type LocalSessionCreateRecovery } from './local-session-create-errors';
import {
  type LocalSessionCreateOrchestrator,
  type LocalSessionCreateOrchestratorState,
} from './local-session-create-orchestrator-shared';
import { createLocalSessionCreateOrchestrator } from './use-local-session-create-orchestrator';
import {
  buildLocalSessionCreateRequest,
  type BuiltLocalSessionCreateRequest,
} from './local-session-create-request';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import {
  createLocalSessionRequestIdStore,
  type LocalSessionRequestIdStore,
  type RequestIdUuid,
} from './local-session-request-id';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 60_000;

const showErrorNoOp = () => {
  void 0;
};

const noOpCleanup = () => {
  void 0;
};

function notificationHapticFeedbackType(
  kind: 'success' | 'warning' | 'error'
): Haptics.NotificationFeedbackType {
  if (kind === 'success') {
    return Haptics.NotificationFeedbackType.Success;
  }
  if (kind === 'warning') {
    return Haptics.NotificationFeedbackType.Warning;
  }
  return Haptics.NotificationFeedbackType.Error;
}

type Ref<T> = { current: T };

type UseLocalSessionCreateInput = {
  fence: LocalRuntimeFence | null;
  catalog: LocalRuntimeCatalog | null;
  selectedAgentSlug: string | null;
  selectedModel: { providerID: string; modelID: string; variant: string } | null;
  promptRef: Ref<string>;
  hasPromptRef: Ref<boolean>;
};

type LocalSessionCreateViewModel = {
  phase: LocalSessionCreateOrchestratorState['phase'];
  recovery: LocalSessionCreateRecovery | null;
  canSubmit: boolean;
  canRetry: boolean;
  canCheckAgain: boolean;
  isSubmitting: boolean;
};

type LocalSessionCreateActions = {
  submit: () => Promise<void>;
  retry: () => Promise<void>;
  checkAgain: () => Promise<void>;
};

type LocalSessionCreateHook = LocalSessionCreateViewModel & LocalSessionCreateActions;

export const IDLE_STATE: LocalSessionCreateOrchestratorState = { phase: 'idle' };

/**
 * React binding for the `localRuntimeControl.createAndRun` submission
 * orchestrator.
 *
 * The hook is a thin React shell: every state transition is owned by the
 * pure `createLocalSessionCreateOrchestrator` state machine, and every
 * side effect is wired through the orchestrator's dependency seams. The
 * hook is responsible for the four pieces of state that only React can
 * own: the persistent `LocalSessionRequestIdStore`, the long-lived
 * `mutateAsync` from `useMutation`, the `QueryClient` invalidation handle,
 * and the `router.replace` for the post-create detail navigation.
 *
 * The hook does NOT keep a `prompt` field in React state. The user types
 * into a ref-controlled `TextInput` (see the `local-session-config-screen`
 * integration) and the hook reads the ref at submit time so a keystroke
 * does not rebuild the orchestrator and never races an in-flight request.
 *
 * Error toasts: the mutation's `onError` is the sole upstream toast
 * source — wired to `toast.error(error.message)`. The orchestrator's
 * `showError` seam is wired to a no-op at this layer so the orchestrator
 * can still receive its contract (single error surface) without a second
 * toast. Validation errors that never reach the mutation are surfaced
 * through the recovery state's `message` and rendered as a recovery
 * panel; they never trigger a toast.
 */
export function useLocalSessionCreate(input: UseLocalSessionCreateInput): LocalSessionCreateHook {
  const { fence, catalog, selectedAgentSlug, selectedModel, promptRef, hasPromptRef } = input;

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();

  // One persistent requestId store per hook instance. The store survives
  // every render — the orchestrator is allowed to look up the same
  // requestId across submits as long as the fence is unchanged.
  const requestIdStoreRef = useRef<LocalSessionRequestIdStore>(
    createLocalSessionRequestIdStore({
      generateUuid: () => Crypto.randomUUID() as RequestIdUuid,
    })
  );

  const mutation = useMutation(
    trpc.localRuntimeControl.createAndRun.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  // The orchestrator is created when the user actually attempts a submit
  // (so the prompt snapshot is the one at submit time). The instance is
  // preserved across subsequent submits/retry/checkAgain calls as long as
  // the fence/catalog/agent/model triple is unchanged. A change in any of
  // those four invalidates the orchestrator and clears the requestId
  // binding for the old fence.
  const orchestratorRef = useRef<{
    orchestrator: LocalSessionCreateOrchestrator;
    fence: LocalRuntimeFence;
    catalog: LocalRuntimeCatalog;
    selectedAgentSlug: string;
    selectedModel: { providerID: string; modelID: string; variant: string };
  } | null>(null);

  const [orchestratorState, setOrchestratorState] =
    useState<LocalSessionCreateOrchestratorState>(IDLE_STATE);

  // Keep the current orchestrator identity in React state so the subscription
  // effect below depends on a stable, explicit value instead of a mutable ref.
  const [activeOrchestrator, setActiveOrchestrator] =
    useState<LocalSessionCreateOrchestrator | null>(null);

  const deps = useMemo(
    () => ({
      requestIdStore: requestIdStoreRef.current,
      buildRequest: buildLocalSessionCreateRequest,
      createAndRun: async (request: BuiltLocalSessionCreateRequest) => {
        const result = await mutation.mutateAsync(request);
        return result;
      },
      pollReadiness: async ({ sessionId }: { sessionId: string }) => {
        const probe = await trpcClient.cliSessionsV2.readiness.query({ session_id: sessionId });
        return probe;
      },
      sleep: async (ms: number) => {
        await new Promise<void>(resolve => {
          setTimeout(resolve, ms);
        });
      },
      invalidateCaches: async () => {
        await invalidateAgentSessionQueries(queryClient, {
          cliSessionsV2: {
            list: { pathFilter: () => trpc.cliSessionsV2.list.pathFilter() },
            recentRepositories: {
              pathFilter: () => trpc.cliSessionsV2.recentRepositories.pathFilter(),
            },
            search: { pathFilter: () => trpc.cliSessionsV2.search.pathFilter() },
          },
          activeSessions: {
            list: { pathFilter: () => trpc.activeSessions.list.pathFilter() },
          },
        });
      },
      captureEvent: (name: string, properties: Record<string, unknown>) => {
        captureEvent(name, properties as Record<string, string | number | boolean>);
      },
      notificationHaptic: (kind: 'success' | 'warning' | 'error') => {
        void Haptics.notificationAsync(notificationHapticFeedbackType(kind));
      },
      navigate: (path: string) => {
        router.replace(path as Href);
      },
      // The orchestrator still receives its contract surface through
      // `showError`, but the mutation's `onError` is the sole toast source
      // for createAndRun failures. Wiring `showError` to a no-op prevents a
      // duplicate toast while keeping the orchestrator's error recovery path
      // intact.
      showError: showErrorNoOp,
      showInfo: (message: string) => {
        toast.info(message);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollMaxMs: POLL_MAX_MS,
    }),
    [mutation, queryClient, router, trpc]
  );

  // Detect a change in the selection triple. When any field changes the
  // orchestrator's view of the world is no longer current, so we discard
  // the orchestrator and clear the requestId binding for the old fence.
  useEffect(() => {
    if (!fence || !catalog || !selectedAgentSlug || !selectedModel) {
      return;
    }
    const stored = orchestratorRef.current;
    if (stored === null) {
      return;
    }
    const fenceChanged =
      stored.fence.runtimeId !== fence.runtimeId ||
      stored.fence.connectionId !== fence.connectionId;
    if (fenceChanged) {
      requestIdStoreRef.current.clearByFence(stored.fence);
      orchestratorRef.current = null;
      setActiveOrchestrator(null);
      setOrchestratorState(IDLE_STATE);
      return;
    }
    if (
      stored.catalog !== catalog ||
      stored.selectedAgentSlug !== selectedAgentSlug ||
      stored.selectedModel.providerID !== selectedModel.providerID ||
      stored.selectedModel.modelID !== selectedModel.modelID ||
      stored.selectedModel.variant !== selectedModel.variant
    ) {
      orchestratorRef.current = null;
      setActiveOrchestrator(null);
      setOrchestratorState(IDLE_STATE);
    }
  }, [fence, catalog, selectedAgentSlug, selectedModel]);

  // Subscribe to the active orchestrator's state. The orchestrator is
  // created lazily on the first submit, so the effect is a no-op before
  // the user attempts anything. The dependency is the orchestrator identity
  // kept in React state, not a mutable ref.
  useEffect(() => {
    if (activeOrchestrator === null) {
      return noOpCleanup;
    }
    return activeOrchestrator.subscribe(setOrchestratorState);
  }, [activeOrchestrator]);

  const ensureOrchestrator = useCallback(() => {
    if (!fence || !catalog || !selectedAgentSlug || !selectedModel) {
      return null;
    }
    const stored = orchestratorRef.current;
    if (
      stored !== null &&
      stored.fence.runtimeId === fence.runtimeId &&
      stored.fence.connectionId === fence.connectionId &&
      stored.catalog === catalog &&
      stored.selectedAgentSlug === selectedAgentSlug &&
      stored.selectedModel.providerID === selectedModel.providerID &&
      stored.selectedModel.modelID === selectedModel.modelID &&
      stored.selectedModel.variant === selectedModel.variant
    ) {
      return stored.orchestrator;
    }
    const orchestrator = createLocalSessionCreateOrchestrator({
      deps,
      fence,
      catalog,
      selectedAgentSlug,
      selectedModel,
      getPrompt: () => promptRef.current,
    });
    orchestratorRef.current = {
      orchestrator,
      fence,
      catalog,
      selectedAgentSlug,
      selectedModel,
    };
    setActiveOrchestrator(orchestrator);
    // Re-subscribe to the new orchestrator's state.
    setOrchestratorState(orchestrator.getState());
    return orchestrator;
  }, [catalog, deps, fence, promptRef, selectedAgentSlug, selectedModel]);

  const submit = useCallback(async () => {
    const orchestrator = ensureOrchestrator();
    if (!orchestrator) {
      return;
    }
    await orchestrator.submit();
  }, [ensureOrchestrator]);

  const retry = useCallback(async () => {
    const orchestrator = orchestratorRef.current?.orchestrator ?? ensureOrchestrator();
    if (!orchestrator) {
      return;
    }
    await orchestrator.retry();
  }, [ensureOrchestrator]);

  const checkAgain = useCallback(async () => {
    const orchestrator = orchestratorRef.current?.orchestrator ?? ensureOrchestrator();
    if (!orchestrator) {
      return;
    }
    await orchestrator.checkAgain();
  }, [ensureOrchestrator]);

  const isSelectionComplete =
    fence !== null && catalog !== null && selectedAgentSlug !== null && selectedModel !== null;
  const isSubmitting = orchestratorState.phase === 'submitting';
  const canSubmit = isSelectionComplete && hasPromptRef.current && !isSubmitting;
  const canRetry =
    orchestratorState.phase === 'recovery' && orchestratorState.recovery.ctaLabel === 'Retry';
  const canCheckAgain =
    orchestratorState.phase === 'recovery' &&
    orchestratorState.recovery.kind === 'readiness-timeout';

  return {
    phase: orchestratorState.phase,
    recovery: orchestratorState.phase === 'recovery' ? orchestratorState.recovery : null,
    canSubmit,
    canRetry,
    canCheckAgain,
    isSubmitting,
    submit,
    retry,
    checkAgain,
  };
}
