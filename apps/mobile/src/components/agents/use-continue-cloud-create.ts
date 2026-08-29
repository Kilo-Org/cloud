// Performs one `prepareSession` clone for the Cloud Agent Continue entry: a
// hoisted operation key, a safe-retry outbox row, and post-success navigation.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import * as Haptics from 'expo-haptics';

import { type AgentMode, normalizeAgentMode } from '@/components/agents/mode-normalize';
import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import {
  type ProviderLaunchSelection,
  type ProviderPrepareInput,
  resolveProviderLaunchInput,
} from '@/components/agents/provider-launch-input';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { i18n } from '@/i18n';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { trpcClient, useTRPC } from '@/lib/trpc';

type ContinueDestination = {
  repository: NewSessionRepository | null;
  model: string;
  variant: string;
  launchSelection?: ProviderLaunchSelection | null;
};

export function useContinueCloudCreate(
  organizationId: string | undefined,
  /** Invoked once the clone settled, right before the success navigation. */
  onCreated?: () => void
): (sessionId: KiloSessionId, dest: ContinueDestination, mode: string) => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { userId } = useCurrentUserId();
  const scopeKey = JSON.stringify([userId, organizationId]);
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
    };
  }, [scope]);
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
    async (sessionId: KiloSessionId, dest: ContinueDestination, mode: string) => {
      if (!dest.repository || currentScope.current !== scope) {
        return;
      }
      const launch = resolveProviderLaunchInput(dest.repository, {
        launchSelection: dest.launchSelection,
        accountId: userId,
        organizationId,
      });
      if (!launch) {
        throw Object.assign(
          new Error(
            i18n.t('agentChat.newSession.prefillRepoUnavailable', {
              repo: dest.repository.fullName,
            })
          ),
          { data: { code: 'BAD_REQUEST' } }
        );
      }
      const intentFingerprint = JSON.stringify({
        cloneFromKiloSessionId: sessionId,
        repo: launch.fingerprint,
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
      const outboxLoaded = await whenLoaded();
      if (currentScope.current !== scope) {
        return;
      }
      if (!outboxLoaded) {
        throw new Error(i18n.t('agentChat.newSession.couldNotReadPendingSessions'));
      }
      const operationKey =
        getStoredOperationKey(intentFingerprint) ?? cloudOperationKey.getKey(intentFingerprint);
      // The clone-only prepare schema forbids `prompt` and `initialMessageId`;
      // the clone carries no synthetic turn.
      const baseInput: ContinuePrepareInput = {
        mode: normalizeAgentMode(mode),
        model: dest.model,
        variant: dest.variant || undefined,
        autoCommit: false,
        autoInitiate: true,
        operationKey,
        cloneFromKiloSessionId: sessionId,
        ...launch.input,
      };
      try {
        // Persist the safe-retry row BEFORE the mutate so a crash mid-flight
        // reuses the same key on relaunch instead of minting a duplicate.
        await writeSafeRetry({
          operationKey,
          fingerprint: intentFingerprint,
          input: baseInput,
        });
        if (currentScope.current !== scope) {
          return;
        }

        const result = organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
              ...baseInput,
              organizationId,
            })
          : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);
        if (currentScope.current !== scope) {
          return;
        }
        // The intent settled; the next submit is a fresh intent. Rotate
        // before the post-success work so a UI failure cannot keep the
        // successful key for a retry or rotate it a second time.
        cloudOperationKey.rotateKey();
        await removeOutboxRow(intentFingerprint);
        if (currentScope.current !== scope) {
          return;
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
          await invalidateAgentSessionQueries(queryClient, trpc);
        } catch {
          // A failed cache invalidation is cosmetic; navigation must still run.
        }
        if (currentScope.current !== scope) {
          return;
        }
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {
          // A failed haptics call is cosmetic; stay silent and navigate.
        }
        if (currentScope.current !== scope) {
          return;
        }
        try {
          // Arm the route's busy leave-lock bypass right before the replace so
          // the success navigation is not intercepted as an abandon.
          onCreated?.();
        } catch {
          // The session exists; a host callback failure must not skip navigation.
        }
        if (currentScope.current !== scope) {
          return;
        }
        try {
          // Replace (not push) the continue form with the cloned session so
          // back from the new session returns to the source session.
          replaceWithAgentSession(router, result.kiloSessionId, organizationId);
        } catch {
          // A navigation failure is not a create failure.
        }
      } catch (error) {
        if (currentScope.current !== scope) {
          return;
        }
        // Only `prepareSession` errors reach here; UI failures are contained
        // above. A typed terminal rejection ends the intent.
        if (!isCloudPrepareRetryableError(error)) {
          cloudOperationKey.rotateKey();
          await removeOutboxRow(intentFingerprint);
        }
        if (currentScope.current === scope) {
          throw error;
        }
      }
    },
    [
      organizationId,
      userId,
      scope,
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

/** Clone-only prepare body. Mirrors the ordinary create path's repository fields. */
type ContinuePrepareInput = ProviderPrepareInput & {
  mode: AgentMode;
  model: string;
  variant: string | undefined;
  autoCommit: boolean;
  autoInitiate: true;
  operationKey: string;
  cloneFromKiloSessionId: KiloSessionId;
};
