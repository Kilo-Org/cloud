import { type RefObject, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { type useAgentAttachmentUpload } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { prepareAgentSession } from '@/lib/app-actions/prepare-agent-session';
import { useTRPC } from '@/lib/trpc';

/**
 * A cloud `prepareSession` rejection, classified for the form's inline error.
 * `retryable` keeps the same `operationKey` and offers a retry control;
 * `message` is the server's reason, or the generic copy when it carries none.
 */
export type CloudCreateFailure = {
  retryable: boolean;
  message: string;
};

type UseNewSessionCreatorInput = {
  attachments: ReturnType<typeof useAgentAttachmentUpload>;
  mode: AgentMode;
  model: string;
  organizationId?: string;
  /** Invoked on the success path before navigation; failures never fire it. */
  onCreated?: () => void;
  /**
   * Invoked with a classified cloud-create rejection. When supplied, the form
   * owns the failure feedback (a persistent inline error) and the hook does not
   * also toast, so the person never gets two copies of the same failure.
   */
  onCreateError?: (failure: CloudCreateFailure) => void;
  selectedRepository: NewSessionRepository | null;
  setIsCreating: (value: boolean) => void;
  variant: string;
  /** Commit and push the agent's changes (true) or leave them uncommitted (false). */
  autoCommit: boolean;
  /** Effective environment profile id; omitted from the create body when unset. */
  profileId?: string | null;
};

type UseNewSessionCreatorResult = {
  createSessionFromDraft: () => Promise<void>;
  promptRef: RefObject<string>;
};

/**
 * Owns the side effects of starting a new Cloud Agent session: validating
 * the draft, uploading the composer's attachments, and handing the intent to
 * the shared `prepareAgentSession` core, which runs the `prepareSession`
 * mutation and settles the operation key and safe-retry row. Navigation,
 * analytics, haptics and the host signal all stay here. The route supplies the
 * live draft through `promptRef` so the caller can read the post-settle value
 * without re-rendering the parent.
 */
export function useNewSessionCreator({
  attachments,
  mode,
  model,
  organizationId,
  onCreated,
  onCreateError,
  selectedRepository,
  setIsCreating,
  variant,
  autoCommit,
  profileId,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useStackSafeReplace();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const promptRef = useRef('');
  // P1-A-08b: one `operationKey` per submit intent, so a retry of the same
  // intent dedupes on the ledger instead of spawning a second session.
  const { getKey, rotateKey } = useHoistedOperationKey();
  // P1-E-40c: persist the safe-retry row across relaunch so a crash mid-flight
  // reuses the same key instead of minting a duplicate session.
  const {
    getStoredOperationKey,
    writeSafeRetry,
    remove: removeOutboxRow,
    whenLoaded,
  } = useMutationOutbox();

  const createSessionFromDraft = useCallback(async () => {
    // Read the live, post-settlement draft (see `settleVoiceInputBeforeSubmit`
    // in `useNewSessionCreator` callers). An interim voice transcript can be
    // replaced by an empty final transcript when no speech was recognized;
    // reject empty/whitespace drafts before doing anything else so we never
    // call prepareSession with an empty prompt. The voice controller has
    // already presented its own feedback, so a no-op here preserves the
    // user's draft and screen state without toasting.
    const prompt = resolveNewSessionPromptForCreate(promptRef.current);
    if (prompt === null) {
      return;
    }
    if (prompt.startsWith('/') && attachments.attachments.length > 0) {
      toast.error(i18n.t('agentChat.composer.attachmentsWithSlashCommands'));
      return;
    }

    setIsCreating(true);

    // Upload pending attachments now so the create body carries the real
    // payload. A failed or in-flight chip (including a strip-fail) blocks
    // inside `uploadPending`; `{ ok: false }` is truthy, so test `ok`.
    const uploaded = await attachments.uploadPending();
    if (!uploaded.ok) {
      setIsCreating(false);
      return;
    }

    try {
      // The core owns the retry fingerprint and the safe-retry row: the upload
      // wire is part of both, so a swapped attachment set is a fresh intent.
      const outcome = await prepareAgentSession(
        {
          kind: 'new',
          prompt,
          repository: selectedRepository,
          mode,
          model,
          variant,
          profileId,
          autoCommit,
          attachments: uploaded.wire,
          organizationId,
        },
        {
          getKey,
          rotateKey,
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
        if (outcome.reason === 'outbox-unreadable') {
          // The pending rows were not read as empty: refuse rather than mint a
          // duplicate key. The user's retry re-reads the store.
          toast.error(outcome.message);
          return;
        }
        // One feedback channel: the form's inline error when it accepts the
        // callback, the toast otherwise. Never both for the same rejection.
        if (onCreateError) {
          onCreateError({ retryable: outcome.retryable, message: outcome.message });
        } else {
          toast.error(outcome.message);
        }
        return;
      }

      // The cloud session already exists, so no post-success UI failure may
      // report the create as failed or invite a duplicate retry.
      try {
        // Contained together so neither can skip the host signal below.
        try {
          captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
        } catch {
          // Analytics is cosmetic; stay silent.
        }
        // Signal the host (e.g. clear the new-session draft) before navigating,
        // so the draft is gone by the time the route unmounts and can never be
        // flushed back by an unmount write.
        try {
          onCreated?.();
        } catch {
          // The session exists; a host callback failure must not skip navigation.
        }
        // The uploads now live on the server: drop the composer's local cache
        // copies so owned temp files never outlive the session handoff.
        attachments.reset();
        // Contained on its own so a rejected haptics call still navigates.
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {
          // A failed haptics call is cosmetic; stay silent and navigate.
        }
        // One atomic navigation: `replace` drops the new-session route as it
        // pushes the session route, so back still lands on the session list.
        // The previous form — `push` plus a `RESET` dispatched one frame later —
        // mutated the stack while the native push transition was still running,
        // which crashed Fabric on Android ("addViewAt: failed to insert view
        // ... The specified child already has a parent", Sentry KILO-APP-25).
        replaceWithAgentSession(router, outcome.sessionId, organizationId);
      } catch {
        // Stay silent: no create-failure toast, no duplicate-create retry.
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    selectedRepository,
    model,
    mode,
    variant,
    autoCommit,
    organizationId,
    profileId,
    queryClient,
    trpc,
    router,
    attachments,
    setIsCreating,
    getKey,
    rotateKey,
    getStoredOperationKey,
    writeSafeRetry,
    removeOutboxRow,
    whenLoaded,
    onCreated,
    onCreateError,
  ]);

  return { createSessionFromDraft, promptRef };
}
