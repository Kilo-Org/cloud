import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import {
  type ProviderLaunchSelection,
  type ProviderPrepareInput,
  resolveProviderLaunchInput,
} from '@/components/agents/provider-launch-input';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
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
  selectedRepository: NewSessionRepository | null;
  launchSelection?: ProviderLaunchSelection | null;
  setIsCreating: (value: boolean) => void;
  variant: string;
  /** Commit and push the agent's changes (true) or leave them uncommitted (false). */
  autoCommit: boolean;
  /** Effective environment profile id; omitted from the create body when unset. */
  profileId?: string | null;
};

type PrepareSessionInput = ProviderPrepareInput & {
  prompt: string;
  initialMessageId: string;
  mode: AgentMode;
  model: string;
  variant: string | undefined;
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
  selectedRepository,
  launchSelection,
  setIsCreating,
  variant,
  autoCommit,
  profileId,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { userId } = useCurrentUserId();
  const launch = resolveProviderLaunchInput(selectedRepository, {
    launchSelection,
    accountId: userId,
    organizationId,
  });
  const scopeKey = JSON.stringify([userId, organizationId, launch?.fingerprint]);
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  const setIsCreatingRef = useRef(setIsCreating);
  setIsCreatingRef.current = setIsCreating;
  useEffect(() => {
    currentScope.current = scope;
    // A replacement scope starts idle; retired requests cannot reset its launch.
    setIsCreatingRef.current(false);
    return () => {
      currentScope.current = null;
    };
  }, [scope]);
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
    if (prompt === null || currentScope.current !== scope) {
      return;
    }
    if (!launch) {
      if (selectedRepository) {
        toast.error(
          i18n.t('agentChat.newSession.prefillRepoUnavailable', {
            repo: selectedRepository.fullName,
          })
        );
      }
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
    if (!uploaded.ok || currentScope.current !== scope) {
      if (currentScope.current === scope) {
        setIsCreating(false);
      }
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
      repo: launch.fingerprint,
      autoCommit,
      organizationId: organizationId ?? null,
      profileId: profileId ?? null,
      attachments: attachmentWire ?? null,
    });
    // Old GitHub safe-retry rows used the bare name. Never apply that lookup to
    // a pinned selection. Remove only after old clients/records disappear and
    // the 30-day ledger window expires; preserve the serialized field order.
    const legacyIntentFingerprint =
      launchSelection === undefined && selectedRepository?.platform === 'github'
        ? JSON.stringify({
            prompt,
            mode,
            model,
            variant: variant || undefined,
            repo: selectedRepository.fullName,
            autoCommit,
            organizationId: organizationId ?? null,
            profileId: profileId ?? null,
            attachments: attachmentWire ?? null,
          })
        : null;
    // Reuse a stored safe-retry key for this fingerprint on relaunch; mint a
    // fresh key only when no stored row exists. A stored row must never be
    // replaced by a new in-memory key. Gate on the outbox load first: a submit
    // that races the launch load would read empty rows and mint a duplicate.
    // A failed outbox read reads as no stored rows, so refuse instead of
    // minting a fresh key over a row whose POST the server may have accepted.
    const outboxLoaded = await whenLoaded();
    if (currentScope.current !== scope) {
      return;
    }
    if (!outboxLoaded) {
      toast.error(i18n.t('agentChat.newSession.couldNotReadPendingSessions'));
      setIsCreating(false);
      return;
    }
    let operationKey = getStoredOperationKey(intentFingerprint);
    // The consumed legacy row migrates to the scoped fingerprint so the normal
    // success/failure cleanup only ever touches the scoped row. Delete it only
    // after the scoped row exists: a crash between the two writes would
    // otherwise lose the key and mint a duplicate session on relaunch.
    let legacyRowToDrop: string | null = null;
    if (operationKey === null && legacyIntentFingerprint !== null) {
      operationKey = getStoredOperationKey(legacyIntentFingerprint);
      if (operationKey !== null) {
        legacyRowToDrop = legacyIntentFingerprint;
      }
    }
    operationKey ??= getKey(intentFingerprint);

    try {
      const initialMessageId = generateMessageId();
      const baseInput: PrepareSessionInput = {
        prompt,
        initialMessageId,
        mode,
        model,
        variant: variant || undefined,
        autoCommit,
        autoInitiate: true,
        operationKey,
        ...launch.input,
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
      if (currentScope.current !== scope) {
        return;
      }
      if (legacyRowToDrop !== null) {
        await removeOutboxRow(legacyRowToDrop);
      }
      if (currentScope.current !== scope) {
        return;
      }

      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);
      // A late prepare cannot clear or navigate the newly selected owner's form.
      if (currentScope.current !== scope) {
        return;
      }

      // Rotate before the post-success work so a UI failure cannot keep the
      // successful key for a retry.
      rotateKey();
      await removeOutboxRow(intentFingerprint);
      if (currentScope.current !== scope) {
        return;
      }

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
        if (currentScope.current !== scope) {
          return;
        }
        // Signal the host (e.g. clear the new-session draft) before navigating,
        // so the draft is gone by the time the route unmounts and can never be
        // flushed back by an unmount write.
        try {
          onCreated?.();
        } catch {
          // The session exists; a host callback failure must not skip navigation.
        }
        if (currentScope.current !== scope) {
          return;
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
        if (currentScope.current !== scope) {
          return;
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
      if (currentScope.current !== scope) {
        return;
      }
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
      if (currentScope.current === scope) {
        setIsCreating(false);
      }
    }
  }, [
    selectedRepository,
    launchSelection,
    launch,
    scope,
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
