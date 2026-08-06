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
import { useHoistedOperationKey } from '@/lib/pr-review/merge/pr-operation-ledger';
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
  // P1-A-08b: one `operationKey` per submit intent, hoisted so a retry of the
  // same intent reuses the key (the ledger dedupes/reconciles instead of
  // spawning a second session) and rotated on success or a typed terminal
  // rejection. The fingerprint covers every intent-defining input, so a
  // changed draft/selection becomes a fresh intent with a fresh key.
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

    // The wire payload is the exact attachment input the create carries (the
    // upload path plus every uploaded remote filename). Include it in the
    // intent fingerprint so a changed attachment set becomes a fresh intent
    // with a fresh key — otherwise a same-key retry after the user swapped
    // files would replay the previous intent's ledger result. Computed once,
    // before the fingerprint, and reused for the create body so the two
    // cannot disagree. At submit time the screen has already gated on
    // `attachments.isUploading` / `attachments.hasFailedAttachments`, so the
    // payload is stable across retries of the same intent.
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

      // The intent settled (the ledger now owns the create); the next submit
      // is a fresh intent with a fresh key.
      rotateKey();

      captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
      await invalidateAgentSessionQueries(queryClient, trpc);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const path = organizationId
        ? `/(app)/agent-chat/${result.kiloSessionId}?organizationId=${organizationId}`
        : `/(app)/agent-chat/${result.kiloSessionId}`;
      router.push(path as Href);
      requestAnimationFrame(() => {
        navigation.dispatch(state => {
          const routes = state.routes.filter((r: { name: string }) => r.name !== 'agent-chat/new');
          return {
            type: 'RESET' as const,
            payload: { ...state, routes, index: routes.length - 1 },
          };
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create session';
      toast.error(message);
      // A typed terminal rejection ends the intent; retryable failures
      // (transport and `creation_in_progress`) keep the key.
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
