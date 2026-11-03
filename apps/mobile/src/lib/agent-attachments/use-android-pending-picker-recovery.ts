import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { normalizeImageAsset } from '@/components/agents/attachment-picker';
import {
  type AttachmentSurface,
  clearPickerLaunchContext,
  PICKER_LAUNCH_CONTEXT_TTL_MS,
  readPickerLaunchContext,
} from '@/lib/agent-attachments/picker-launch-context';
import {
  consumeAndroidPendingPickerResult,
  discardAndroidPendingPickerResult,
} from '@/lib/agent-attachments/pending-picker-result';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

type UseAndroidPendingPickerRecoveryOptions = {
  surface: AttachmentSurface;
  sessionId: string | null;
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
};

/**
 * Recover a pending Android image-picker result after an Activity recreation.
 * Runs on mount and on `AppState` `'active'`. Accepts the result only when the
 * stored launch context matches the current account, surface, and session, and
 * is younger than 10 minutes. A matching context is consumed and cleared once.
 * An expired context is discarded and cleared (no composer should attach it).
 * A non-expired mismatch (wrong account/surface/session) is left untouched so
 * the matching composer — multiple composers stay mounted — can still read it.
 *
 * Best effort: a failed consume, candidate add, or clear is reported once and
 * swallowed, and a failed clear leaves the stored context for the next
 * app-active edge to retry. Both call sites fire this off without awaiting it.
 */
export function useAndroidPendingPickerRecovery(
  options: UseAndroidPendingPickerRecoveryOptions
): void {
  const { surface, sessionId, addCandidates } = options;
  const { userId } = useCurrentUserId();

  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const addCandidatesRef = useRef(addCandidates);
  addCandidatesRef.current = addCandidates;
  const inFlightRef = useRef(false);

  const recover = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    try {
      const context = await readPickerLaunchContext();
      if (!context) {
        return;
      }
      const currentUserId = userIdRef.current;
      // The user id can still be empty right after an Activity recreation.
      // Do NOT consume or clear: wait for it to arrive. The effect re-runs
      // when `userId` becomes available.
      if (currentUserId === undefined) {
        return;
      }
      const expired = Date.now() - context.launchedAt > PICKER_LAUNCH_CONTEXT_TTL_MS;
      const matches =
        !expired &&
        context.userId === currentUserId &&
        context.surface === surfaceRef.current &&
        context.sessionId === sessionIdRef.current;
      if (matches) {
        const assets = await consumeAndroidPendingPickerResult();
        // Attach before clearing: the result is already consumed and cannot be
        // read again, so a failed clear must not skip the assets the person
        // picked. A clear that still fails leaves the context for the next
        // app-active edge, which consumes nothing and retries the clear.
        if (assets.length > 0) {
          await addCandidatesRef.current(assets.map(asset => normalizeImageAsset(asset)));
        }
        await clearPickerLaunchContext();
        return;
      }
      if (expired) {
        // A truly stale result no composer should attach: discard the pending
        // result and clear the context so a later launch cannot receive it.
        await discardAndroidPendingPickerResult();
        await clearPickerLaunchContext();
      }
      // Non-expired mismatch (wrong account/surface/session): another mounted
      // composer may still match this context. Leave both the context and the
      // native result for that composer.
    } catch (error) {
      // Best effort and self-contained: the call sites fire this off with
      // `void recover()`, so a rejection must not escape as an unhandled one.
      // A failed clear leaves the stored context in place, so the next
      // app-active edge retries it.
      captureTelemetry({
        error,
        level: 'warning',
        tags: { 'error.subsystem': 'agent_attachments', 'error.operation': 'picker_recovery' },
        fingerprint: ['android-picker-recovery-failure'],
      });
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void recover();
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void recover();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [recover, userId]);
}
