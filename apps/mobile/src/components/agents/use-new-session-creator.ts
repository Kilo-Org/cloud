import { type RefObject, useCallback, useRef } from 'react';
import { type Href, useNavigation, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { type AgentMode } from '@/components/agents/mode-selector';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { isCloudPrepareRetryableError } from '@/components/agents/mobile-session-manager';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import { useHoistedOperationKey } from '@/lib/operation-key';
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
  selectedRepo: string;
  setIsCreating: (value: boolean) => void;
  variant: string;
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
  selectedRepo,
  setIsCreating,
  variant,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const promptRef = useRef('');
  // P1-A-08b: one `operationKey` per submit intent, so a retry of the same
  // intent dedupes on the ledger instead of spawning a second session.
  const { getKey, rotateKey } = useHoistedOperationKey();

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
      toast.error('Attachments cannot be sent with slash commands.');
      return;
    }

    setIsCreating(true);

    // Computed once and reused for both the fingerprint and the create body, so
    // the two cannot disagree and a swapped attachment set is a fresh intent.
    const attachmentWire = attachments.toWirePayload();
    const intentFingerprint = JSON.stringify({
      prompt,
      mode,
      model,
      variant: variant || undefined,
      repo: selectedRepo,
      organizationId: organizationId ?? null,
      attachments: attachmentWire ?? null,
    });
    const operationKey = getKey(intentFingerprint);

    try {
      const initialMessageId = generateMessageId();
      const baseInput: {
        prompt: string;
        initialMessageId: string;
        mode: AgentMode;
        model: string;
        variant: string | undefined;
        githubRepo: string;
        autoCommit: boolean;
        autoInitiate: boolean;
        operationKey: string;
        attachments?: AgentAttachmentWire;
      } = {
        prompt,
        initialMessageId,
        mode,
        model,
        variant: variant || undefined,
        githubRepo: selectedRepo,
        autoCommit: true,
        autoInitiate: true,
        operationKey,
      };
      if (attachmentWire) {
        baseInput.attachments = attachmentWire;
      }

      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);

      // Rotate before the post-success work so a UI failure cannot keep the
      // successful key for a retry.
      rotateKey();

      // The cloud session already exists, so no post-success UI failure may
      // report the create as failed or invite a duplicate retry.
      try {
        captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
        await invalidateAgentSessionQueries(queryClient, trpc);
        // Contained on its own so a rejected haptics call still navigates.
        try {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch {
          // A failed haptics call is cosmetic; stay silent and navigate.
        }
        const path = organizationId
          ? `/(app)/agent-chat/${result.kiloSessionId}?organizationId=${organizationId}`
          : `/(app)/agent-chat/${result.kiloSessionId}`;
        router.push(path as Href);
        requestAnimationFrame(() => {
          // Runs after the surrounding try returned, so a failure here would
          // escape uncaught. The stack cleanup is cosmetic; contain it.
          try {
            navigation.dispatch(state => {
              const routes = state.routes.filter(
                (r: { name: string }) => r.name !== 'agent-chat/new'
              );
              return {
                type: 'RESET' as const,
                payload: { ...state, routes, index: routes.length - 1 },
              };
            });
          } catch {
            // The session already exists; stay silent.
          }
        });
      } catch {
        // Stay silent: no create-failure toast, no duplicate-create retry.
      }
    } catch (error) {
      // Only `prepareSession` errors reach here; UI failures are swallowed.
      const message = error instanceof Error ? error.message : 'Failed to create session';
      toast.error(message);
      // A typed terminal rejection ends the intent; a retryable one keeps the key.
      if (!isCloudPrepareRetryableError(error)) {
        rotateKey();
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    selectedRepo,
    model,
    mode,
    variant,
    organizationId,
    queryClient,
    trpc,
    router,
    navigation,
    attachments,
    setIsCreating,
    getKey,
    rotateKey,
  ]);

  return { createSessionFromDraft, promptRef };
}
