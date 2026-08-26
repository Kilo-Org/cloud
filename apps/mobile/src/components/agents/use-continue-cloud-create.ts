// Performs one `prepareSession` clone for the Cloud Agent Continue entry: a
// hoisted operation key, a safe-retry outbox row, and post-success navigation.
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import * as Haptics from 'expo-haptics';

import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { i18n } from '@/i18n';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { trpcClient, useTRPC } from '@/lib/trpc';

export function useContinueCloudCreate(
  organizationId: string | undefined,
  /** Invoked once the clone settled, right before the success navigation. */
  onCreated?: () => void
): (
  sessionId: KiloSessionId,
  dest: { repo: string; model: string; variant: string },
  mode: string
) => Promise<void> {
  const router = useRouter();
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
      dest: { repo: string; model: string; variant: string },
      mode: string
    ) => {
      const intentFingerprint = JSON.stringify({
        cloneFromKiloSessionId: sessionId,
        repo: dest.repo,
        model: dest.model,
        variant: dest.variant || undefined,
        mode,
        organizationId: organizationId ?? null,
      });
      // Reuse a stored safe-retry key for this fingerprint on relaunch; mint a
      // fresh key only when no stored row exists. A stored row must never be
      // replaced by a new in-memory key. Gate on the outbox load first: a
      // continue that races the launch load would read empty rows and mint a
      // duplicate.
      // A failed outbox read reads as no stored rows, so refuse instead of
      // minting a fresh key over a row whose POST the server may have accepted.
      if (!(await whenLoaded())) {
        throw new Error(i18n.t('agentChat.newSession.couldNotReadPendingSessions'));
      }
      const operationKey =
        getStoredOperationKey(intentFingerprint) ?? cloudOperationKey.getKey(intentFingerprint);
      // The clone-only prepare schema forbids `prompt` and `initialMessageId`;
      // the clone carries no synthetic turn.
      const baseInput = {
        mode: normalizeAgentMode(mode),
        model: dest.model,
        variant: dest.variant || undefined,
        githubRepo: dest.repo,
        autoCommit: false,
        autoInitiate: true as const,
        operationKey,
        cloneFromKiloSessionId: sessionId,
      };
      try {
        // Persist the safe-retry row BEFORE the mutate so a crash mid-flight
        // reuses the same key on relaunch instead of minting a duplicate.
        await writeSafeRetry({
          operationKey,
          fingerprint: intentFingerprint,
          input: baseInput,
        });

        const result = organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
              ...baseInput,
              organizationId,
            })
          : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);
        // The intent settled; the next submit is a fresh intent. Rotate
        // before the post-success work so a UI failure cannot keep the
        // successful key for a retry or rotate it a second time.
        cloudOperationKey.rotateKey();
        await removeOutboxRow(intentFingerprint);

        // The cloud session already exists, so no post-success UI failure may
        // report the create as failed or invite a duplicate retry. Each step is
        // contained on its own so one failure cannot skip the navigation.
        try {
          captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
        } catch {
          // Analytics is best-effort; stay silent.
        }
        try {
          await invalidateAgentSessionQueries(queryClient, trpc);
        } catch {
          // A failed cache invalidation is cosmetic; navigation must still run.
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
          replaceWithAgentSession(router, result.kiloSessionId, organizationId);
        } catch {
          // A navigation failure is not a create failure.
        }
      } catch (error) {
        // Only `prepareSession` errors reach here; UI failures are contained
        // above. A typed terminal rejection ends the intent.
        if (!isCloudPrepareRetryableError(error)) {
          cloudOperationKey.rotateKey();
          await removeOutboxRow(intentFingerprint);
        }
        throw error;
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
