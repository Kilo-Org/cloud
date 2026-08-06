import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type Href, useNavigation, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { type AgentMode } from '@/components/agents/mode-selector';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import { captureEvent, SESSION_CREATED_EVENT } from '@/lib/analytics/posthog';
import {
  type AgentAttachmentWire,
  type useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import {
  clearDraft,
  flushDraft,
  isStringDraft,
  loadDraft,
  NEW_SESSION_DRAFT_KEY,
} from '@/lib/persist/drafts';
import { trpcClient, useTRPC } from '@/lib/trpc';

type UseNewSessionCreatorInput = {
  attachments: ReturnType<typeof useAgentAttachmentUpload>;
  mode: AgentMode;
  model: string;
  organizationId?: string;
  /** Invoked on the success path before navigation; failures never fire it. */
  onCreated?: () => void;
  selectedRepo: string;
  setIsCreating: (value: boolean) => void;
  variant: string;
};

type UseNewSessionCreatorResult = {
  createSessionFromDraft: () => Promise<void>;
  promptRef: RefObject<string>;
};

type UseFencedDraftLoadInput = {
  userId: string | undefined;
  isIdentityLoading: boolean;
  /** Full draft entity key under `draft:<userId>` (e.g. `agent-composer:new`). */
  entityKey: string;
};

/**
 * Loads a durable string draft under `draft:<userId>` once per
 * identity/entity generation. Resets to the not-settled state whenever the
 * identity or entity changes, and only the newest generation's load may
 * publish: every effect run captures the current generation and every
 * cleanup (unmount or a superseding run) bumps it, so a load started for an
 * older account or session can never publish into the newest screen. `text`
 * stays null until a stored draft (or the absence of one) has loaded.
 */
export function useFencedDraftLoad({
  userId,
  isIdentityLoading,
  entityKey,
}: UseFencedDraftLoadInput): {
  settled: boolean;
  text: string | null;
} {
  const [draftState, setDraftState] = useState<{ settled: boolean; text: string | null }>({
    settled: false,
    text: null,
  });
  // Reset the settled draft state when the identity or entity changes, so the
  // prompt stays hidden while the new generation's draft loads and never
  // shows the previous account's or session's draft.
  const draftIdentity = `${userId ?? 'anonymous'}\u0000${entityKey}`;
  const [prevDraftIdentity, setPrevDraftIdentity] = useState(draftIdentity);
  if (prevDraftIdentity !== draftIdentity) {
    setPrevDraftIdentity(draftIdentity);
    setDraftState({ settled: false, text: null });
  }
  // Generation fence: a load applies only when its captured generation is
  // still current. Cleanup (unmount or a superseding run) bumps the
  // generation, so a stale load can never publish after a newer run armed
  // itself (refs dodge type-aware flow narrowing).
  const draftLoadGenerationRef = useRef(0);
  useEffect(() => {
    draftLoadGenerationRef.current += 1;
    const generation = draftLoadGenerationRef.current;
    if (!userId) {
      if (!isIdentityLoading) {
        setDraftState({ settled: true, text: null });
      }
      return undefined;
    }
    void (async () => {
      const text = await loadDraft(userId, entityKey, isStringDraft);
      if (draftLoadGenerationRef.current === generation) {
        setDraftState({ settled: true, text: text ?? null });
      }
    })();
    return () => {
      draftLoadGenerationRef.current += 1;
    };
  }, [userId, isIdentityLoading, entityKey]);
  return draftState;
}

type UseRemoteSpawnDraftCleanupInput = {
  userId: string | undefined;
};

/**
 * Owns the new-session draft's fate when the screen leaves after a remote
 * spawn attempt. The spawn dispatch consumes the outcome internally — a
 * success replaces the screen, a failure toasts and stays — and the route
 * arms the attempt marker only once the dispatch admits the spawn (voice
 * settlement and remote admission passed). The route's observable signal is
 * therefore the attempt marker plus the unmount itself: a successful spawn is
 * the one path that unmounts the screen with an attempt recorded. The leaving
 * route clears the consumed `agent-composer:new` entry (the prompt must not
 * reappear on the next new-session visit) instead of flushing it. Without an
 * attempt the unmount flushes the pending debounce, preserving the draft for
 * a normal leave (back button) or a tap that stopped before any spawn attempt
 * (blocked admission, cancelled voice submit).
 *
 * Boundary: a failed spawn followed by a manual leave also clears the draft.
 * The failed spawn itself never clears — the screen stays mounted, so the
 * retry-while-on-screen contract holds — and the recorded trade-off is that a
 * user who abandons the screen after a failed attempt loses the prompt, the
 * same as if the attempt had succeeded.
 */
export function useRemoteSpawnDraftCleanup({ userId }: UseRemoteSpawnDraftCleanupInput): {
  markRemoteSpawnAttempted: () => void;
} {
  const spawnAttemptedRef = useRef(false);
  const markRemoteSpawnAttempted = useCallback(() => {
    spawnAttemptedRef.current = true;
  }, []);
  useEffect(
    () => () => {
      if (!userId) {
        return;
      }
      if (spawnAttemptedRef.current) {
        void clearDraft(userId, NEW_SESSION_DRAFT_KEY);
      } else {
        void flushDraft(userId, NEW_SESSION_DRAFT_KEY);
      }
    },
    [userId]
  );
  return { markRemoteSpawnAttempted };
}

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
  setIsCreating,
  variant,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const promptRef = useRef('');

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
      };
      const wireAttachments = attachments.toWirePayload();
      if (wireAttachments) {
        baseInput.attachments = wireAttachments;
      }

      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);

      captureEvent(SESSION_CREATED_EVENT, { surface: 'cloud-agent' });
      await invalidateAgentSessionQueries(queryClient, trpc);
      // Signal the host (e.g. clear the new-session draft) before navigating,
      // so the draft is gone by the time the route unmounts and can never be
      // flushed back by an unmount write.
      onCreated?.();
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
    onCreated,
  ]);

  return { createSessionFromDraft, promptRef };
}
