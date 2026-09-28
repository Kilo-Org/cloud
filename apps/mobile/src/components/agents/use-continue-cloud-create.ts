// Performs one `prepareSession` clone for the Cloud Agent Continue entry
// through the shared `prepareAgentSession` core: the hoisted operation key,
// the safe-retry outbox row, and the post-success navigation stay here.
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import * as Haptics from 'expo-haptics';

import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { prepareAgentSession } from '@/lib/app-actions/prepare-agent-session';
import { useTRPC } from '@/lib/trpc';

export function useContinueCloudCreate(
  organizationId: string | undefined,
  /** Invoked once the clone settled, right before the success navigation. */
  onCreated?: () => void
): (
  sessionId: KiloSessionId,
  dest: { repository: NewSessionRepository | null; model: string; variant: string },
  mode: string
) => Promise<void> {
  const router = useStackSafeReplace();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  // P1-A-08b: cloud prepares and remote spawns are different intents, so each
  // destination family holds its own hoisted `operationKey`.
  const cloudOperationKey = useHoistedOperationKey();
  // P1-E-40c: persist the safe-retry row across relaunch so a crash mid-flight
  // reuses the same key instead of minting a duplicate session.
  const {
    getStoredOperationKey,
    writeSafeRetry,
    remove: removeOutboxRow,
    whenLoaded,
  } = useMutationOutbox();

  return useCallback(
    async (
      sessionId: KiloSessionId,
      dest: { repository: NewSessionRepository | null; model: string; variant: string },
      mode: string
    ) => {
      const outcome = await prepareAgentSession(
        {
          kind: 'continue',
          cloneFromKiloSessionId: sessionId,
          repository: dest.repository,
          mode: normalizeAgentMode(mode),
          model: dest.model,
          variant: dest.variant,
          organizationId,
        },
        {
          getKey: (fingerprint: string) => cloudOperationKey.getKey(fingerprint),
          rotateKey: () => {
            cloudOperationKey.rotateKey();
          },
          getStoredOperationKey,
          writeSafeRetry,
          removeOutboxRow,
          whenLoaded,
          // Cache invalidation is React Query's; the core owns when it runs.
          invalidate: async () => {
            await invalidateAgentSessionQueries(queryClient, trpc);
          },
        }
      );

      if (!outcome.ok) {
        // The route reports the failure and keeps the form open: a retryable
        // rejection kept the operation key and the safe-retry row, so the next
        // Continue replays the same intent instead of minting a duplicate.
        // Rethrow the rejection the core caught so the route's own
        // retryable/terminal classification (and the copy it picks) is exactly
        // what it was before the shared core owned the call.
        throw outcome.error ?? new Error(outcome.message);
      }

      // The cloud session already exists, so no post-success UI failure may
      // report the create as failed or invite a duplicate retry. Each step is
      // contained on its own so one failure cannot skip the navigation.
      try {
        captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
      } catch {
        // Analytics is best-effort; stay silent.
      }
      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        // A failed haptics call is cosmetic; stay silent and navigate.
      }
      try {
        // Arm the route's busy leave-lock bypass right before the replace so
        // the success navigation is not intercepted as an abandon.
        onCreated?.();
      } catch {
        // The session exists; a host callback failure must not skip navigation.
      }
      try {
        // Replace (not push) the continue form with the cloned session so
        // back from the new session returns to the source session.
        replaceWithAgentSession(router, outcome.sessionId, organizationId);
      } catch {
        // A navigation failure is not a create failure.
      }
    },
    [
      organizationId,
      queryClient,
      router,
      trpc,
      cloudOperationKey,
      getStoredOperationKey,
      writeSafeRetry,
      removeOutboxRow,
      whenLoaded,
      onCreated,
    ]
  );
}
