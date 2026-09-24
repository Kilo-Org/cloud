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
  /** Manual env vars from Advanced Configuration; omitted from the body when empty. */
  manualEnvVars?: Record<string, string>;
  /** Manual setup commands from Advanced Configuration; omitted from the body when empty. */
  setupCommands?: string[];
};

type UseNewSessionCreatorResult = {
  createSessionFromDraft: () => Promise<void>;
  promptRef: RefObject<string>;
};

/**
 * The identity and order of the chips the composer is showing. A create
 * snapshots this before `uploadPending()` and re-checks it before dispatching:
 * the strip keeps taking removes, reorders and (through an already-open
 * picker) adds while a create is in flight, and `uploadPending()` builds its
 * wire from the chips it read *before* its awaits. Ids are UUIDs, so a
 * replaced chip can never compare equal, and the order is the wire's `files`
 * order.
 */
function attachmentDraftSignature(attachments: readonly { id: string }[]): string {
  return attachments.map(attachment => attachment.id).join('|');
}

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
  manualEnvVars,
  setupCommands,
}: UseNewSessionCreatorInput): UseNewSessionCreatorResult {
  const router = useStackSafeReplace();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const promptRef = useRef('');
  // Live mirror of the visible attachment draft, so an in-flight create can
  // tell whether the strip changed behind the snapshot it dispatched. Kept as a
  // render-phase ref (`chat-composer`'s `submitRef` is the same pattern)
  // because the in-flight closure's `attachments` prop is the list from the
  // render that started it.
  const attachmentDraftRef = useRef('');
  attachmentDraftRef.current = attachmentDraftSignature(attachments.attachments);
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
    const draft = promptRef.current;
    const prompt = resolveNewSessionPromptForCreate(draft);
    if (prompt === null) {
      return;
    }
    if (prompt.startsWith('/') && attachments.attachments.length > 0) {
      toast.error(i18n.t('agentChat.composer.attachmentsWithSlashCommands'));
      return;
    }

    setIsCreating(true);

    // The chip set the composer is showing when the create starts, and the set
    // `uploadPending()` reads before its awaits. The strip stays interactive
    // while a create is in flight (locking it would drop the IME on a focused
    // Android input and collapse the pinned footer, exactly like the prompt),
    // so a remove, reorder or add during the upload leaves the wire it builds
    // describing chips the user can no longer see.
    const submittedAttachments = attachmentDraftRef.current;

    // Upload pending attachments now so the create body carries the real
    // payload. A failed or in-flight chip (including a strip-fail) blocks
    // inside `uploadPending`; `{ ok: false }` is truthy, so test `ok`.
    const uploaded = await attachments.uploadPending();
    if (!uploaded.ok) {
      setIsCreating(false);
      return;
    }

    // The dispatched payload is the trimmed `prompt`, so compare the live
    // draft through the same projection: a trailing space, or an
    // IME/autocorrect composition commit that leaves the trimmed text
    // identical, is not a semantic edit and must not cancel a create whose
    // body did not change.
    const promptChanged = (): boolean =>
      resolveNewSessionPromptForCreate(promptRef.current) !== prompt;
    // Only the chip identity and order are the visible draft, so an upload
    // still advancing its progress does not read as a change. A changed set
    // does: submitting a file the user removed, or dropping one they added,
    // must never ride the wire.
    const attachmentsChanged = (): boolean => attachmentDraftRef.current !== submittedAttachments;

    // The keyboard stays up while a create is in flight (making a focused
    // Android input non-editable drops the IME and collapses the pinned
    // footer), so the composer keeps taking edits. This attempt holds the
    // snapshot above: a draft the user changed mid-flight is a request for
    // different text or a different payload, so cancel before the create is
    // dispatched instead of discarding the edit. Their edited draft stays for
    // the next Start. The same predicate goes to the core, so the outbox-load
    // and safe-retry windows — where the composer is also still editable — are
    // covered too.
    if (promptChanged() || attachmentsChanged()) {
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
          envVars: manualEnvVars,
          setupCommands,
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
          // The composer stays editable until the request is sent, so the core
          // re-checks the draft — text and attachment chips — immediately
          // before the mutate and abandons an unsent intent whose payload
          // changed.
          shouldAbort: () => promptChanged() || attachmentsChanged(),
          // Cache invalidation is React Query's; the core owns when it runs.
          invalidate: async () => {
            await invalidateAgentSessionQueries(queryClient, trpc);
          },
        }
      );

      if (!outcome.ok) {
        if (outcome.reason === 'aborted') {
          // The draft — text or attachment chips — changed after the snapshot
          // was taken and the request was never sent: stay silent and keep the
          // edited draft for the next Start. Starting over is the user's own
          // next action, not a failure.
          return;
        }
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
    manualEnvVars,
    setupCommands,
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
