import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { normalizeImageAsset } from '@/components/agents/attachment-picker';
import {
  clearPickerLaunchContext,
  readPickerLaunchContext,
} from '@/lib/agent-attachments/picker-launch-context';
import {
  consumeAndroidPendingPickerResult,
  discardAndroidPendingPickerResult,
} from '@/lib/agent-attachments/pending-picker-result';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';

const PICKER_LAUNCH_CONTEXT_TTL_MS = 10 * 60 * 1000;

type UseAndroidPendingPickerRecoveryOptions = {
  surface: 'agent-new' | 'agent-chat';
  sessionId: string | null;
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
};

/**
 * Recover a pending Android image-picker result after an Activity recreation.
 * Runs on mount and on `AppState` `'active'`. Accepts the result only when the
 * stored launch context matches the current account, surface, and session, and
 * is younger than 10 minutes. Clears the context once consumed or discarded so
 * one launch can never be matched twice.
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
        await clearPickerLaunchContext();
        if (assets.length > 0) {
          await addCandidatesRef.current(assets.map(asset => normalizeImageAsset(asset)));
        }
        return;
      }
      // Mismatch (wrong account/surface/session) or expired: discard the
      // pending result so a later launch cannot receive a stale result, then
      // clear the context.
      await discardAndroidPendingPickerResult();
      await clearPickerLaunchContext();
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
