import { type RefObject, useCallback, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { type AgentMode } from '@/components/agents/mode-selector';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import {
  type AgentAttachmentWire,
  type useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { trpcClient, useTRPC } from '@/lib/trpc';

type UseNewSessionCreatorInput = {
  attachments: ReturnType<typeof useAgentAttachmentUpload>;
  mode: AgentMode;
  model: string;
  organizationId?: string;
  /** Invoked on the success path before navigation; failures never fire it. */
  onCreated?: () => void;
  selectedRepo: string;
  githubIntegrationId?: string;
  setIsCreating: (value: boolean) => void;
  variant: string;
  /** Commit and push the agent's changes (true) or leave them uncommitted (false). */
  autoCommit: boolean;
  /** Effective environment profile id; omitted from the create body when unset. */
  profileId?: string | null;
};

type PrepareSessionInput = {
  prompt: string;
  initialMessageId: string;
  mode: AgentMode;
  model: string;
  variant: string | undefined;
  githubRepo: string;
  githubIntegrationId?: string;
  autoCommit: boolean;
  autoInitiate: boolean;
  operationKey: string;
  profileId?: string;
  attachments?: AgentAttachmentWire;
};

type UseNewSessionCreatorResult = {
  createSessionFromDraft: () => Promise<void>;
  promptRef: RefObject<string>;
};

/**
 * Owns the side effects of starting a new Cloud Agent session: validating
 * the draft, calling the tRPC `prepareSession` mutation, navigating to the
 * session, and reporting the analytics event. The route supplies the live
 * draft through `promptRef` so the caller can read the post-settle value
 * without re-rendering the parent.
 */
export function useNewSessionCreator({
  attachments,
  mode,
  model,
  organizationId,
  onCreated,
  selectedRepo,
  githubIntegrationId,
  setIsCreating,
  variant,
  autoCommit,
  profileId,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useRouter();
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

    // Warn (never block) when a chip kept its original image because
    // metadata stripping failed: the photo may still carry EXIF/GPS.
    if (attachments.attachments.some(attachment => attachment.metadataStripFailed === true)) {
      toast.warning(i18n.t('agentChat.composer.photoMetadataNotRemoved'));
    }

    // Upload pending attachments now so the create body carries the real
    // payload. `uploaded` is a plain object; `{ ok: false }` is truthy, so
    // test `ok`.
    const uploaded = await attachments.uploadPending();
    if (!uploaded.ok) {
      setIsCreating(false);
      return;
    }

    // Computed once and reused for both the fingerprint and the create body, so
    // the two cannot disagree and a swapped attachment set is a fresh intent.
    const attachmentWire = uploaded.wire;
    const intentFingerprint = JSON.stringify({
      prompt,
      mode,
      model,
      variant: variant || undefined,
      repo: selectedRepo,
      githubIntegrationId: githubIntegrationId ?? null,
      autoCommit,
      organizationId: organizationId ?? null,
      profileId: profileId ?? null,
      attachments: attachmentWire ?? null,
    });
    // Reuse a stored safe-retry key for this fingerprint on relaunch; mint a
    // fresh key only when no stored row exists. A stored row must never be
    // replaced by a new in-memory key. Gate on the outbox load first: a submit
    // that races the launch load would read empty rows and mint a duplicate.
    // A failed outbox read reads as no stored rows, so refuse instead of
    // minting a fresh key over a row whose POST the server may have accepted.
    if (!(await whenLoaded())) {
      toast.error(i18n.t('agentChat.newSession.couldNotReadPendingSessions'));
      setIsCreating(false);
      return;
    }
    const operationKey = getStoredOperationKey(intentFingerprint) ?? getKey(intentFingerprint);

    try {
      const initialMessageId = generateMessageId();
      const baseInput: PrepareSessionInput = {
        prompt,
        initialMessageId,
        mode,
        model,
        variant: variant || undefined,
        githubRepo: selectedRepo,
        ...(githubIntegrationId ? { githubIntegrationId } : {}),
        autoCommit,
        autoInitiate: true,
        operationKey,
      };
      if (profileId) {
        baseInput.profileId = profileId;
      }
      if (attachmentWire) {
        baseInput.attachments = attachmentWire;
      }

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

      // Rotate before the post-success work so a UI failure cannot keep the
      // successful key for a retry.
      rotateKey();
      await removeOutboxRow(intentFingerprint);

      // The cloud session already exists, so no post-success UI failure may
      // report the create as failed or invite a duplicate retry.
      try {
        // Contained together so neither can skip the host signal below.
        try {
          captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
          await invalidateAgentSessionQueries(queryClient, trpc);
        } catch {
          // Analytics and cache invalidation are cosmetic; stay silent.
        }
        // Signal the host (e.g. clear the new-session draft) before navigating,
        // so the draft is gone by the time the route unmounts and can never be
        // flushed back by an unmount write.
        try {
          onCreated?.();
        } catch {
          // The session exists; a host callback failure must not skip navigation.
        }
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
        replaceWithAgentSession(router, result.kiloSessionId, organizationId);
      } catch {
        // Stay silent: no create-failure toast, no duplicate-create retry.
      }
    } catch (error) {
      // Only `prepareSession` errors reach here; UI failures are swallowed.
      const message =
        error instanceof Error ? error.message : i18n.t('agentChat.newSession.failedToCreate');
      toast.error(message);
      // A typed terminal rejection ends the intent; a retryable one keeps the key.
      if (!isCloudPrepareRetryableError(error)) {
        rotateKey();
        await removeOutboxRow(intentFingerprint);
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    selectedRepo,
    githubIntegrationId,
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
  ]);

  return { createSessionFromDraft, promptRef };
}
