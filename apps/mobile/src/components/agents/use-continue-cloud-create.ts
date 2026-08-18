// The cloud-agent leg of `useContinueSession`: one `prepareSession` call, its
// hoisted operation key, and the contained post-success UI work. Split out of
// `use-continue-session.ts` (which keeps the paging drain, destination
// resolution, and the remote spawn leg) so each file stays under the
// max-lines limit.
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';

import { normalizeAgentMode } from '@/components/agents/mode-options';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { trpcClient, useTRPC } from '@/lib/trpc';

export function useContinueCloudCreate(
  organizationId: string | undefined
): (
  seed: string,
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
    async (seed: string, dest: { repo: string; model: string; variant: string }, mode: string) => {
      const intentFingerprint = JSON.stringify({
        seed,
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
      await whenLoaded();
      const operationKey =
        getStoredOperationKey(intentFingerprint) ?? cloudOperationKey.getKey(intentFingerprint);
      const initialMessageId = generateMessageId();
      const baseInput = {
        prompt: seed,
        initialMessageId,
        mode: normalizeAgentMode(mode),
        model: dest.model,
        variant: dest.variant || undefined,
        githubRepo: dest.repo,
        autoCommit: false,
        autoInitiate: true,
        operationKey,
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
          router.push(getAgentSessionPath(result.kiloSessionId, organizationId));
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
    ]
  );
}
