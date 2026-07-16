import { type KiloSessionId } from 'cloud-agent-sdk';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useSessionMutations } from '@/lib/hooks/use-session-mutations';

import {
  getSessionDetailRenameState,
  initialRenameState,
  renameStateReducer,
} from './session-detail-rename-state';

type SessionDetailRenameApi = {
  title: string;
  isTitleInteractive: boolean;
  isModalOpen: boolean;
  modalInitialValue: string;
  openModal: () => void;
  closeModal: () => void;
  /**
   * Persist a new title. Awaits the shared `renameSessionAsync` so a
   * rejection propagates back to the caller (typically `RenameModal`,
   * which keeps the modal open and shows the inline error). The shared
   * mutation hook owns the user-visible error toast and stored-list
   * optimistic update/rollback/invalidation.
   */
  submit: (next: string) => Promise<void>;
};

type SessionDetailRenameInput = {
  sessionId: KiloSessionId;
  isLoaded: boolean;
  serverTitle: string | undefined;
  fallbackTitle: string;
};

/**
 * Owns the rename modal and the optimistic header title for the session
 * detail screen. The shared `useSessionMutations` hook continues to own
 * the list-cache optimistic update/rollback, the user-visible error toast,
 * per-session serialization, and list invalidation — this hook only
 * mirrors the rename into the local header until the authoritative server
 * title (or route change) catches up.
 */
export function useSessionDetailRename({
  sessionId,
  isLoaded,
  serverTitle,
  fallbackTitle,
}: Readonly<SessionDetailRenameInput>): SessionDetailRenameApi {
  const { renameSessionAsync } = useSessionMutations();
  const [renameState, dispatch] = useReducer(renameStateReducer, initialRenameState());
  const lastSeenServerTitleRef = useRef<string | undefined>(serverTitle);

  // Drop the optimistic override when the route's session changes so a
  // previous screen's pending rename can't leak onto the next one. The
  // component is keyed on the session in the parent, so a route change
  // remounts this hook with a fresh ref and fresh state — this effect
  // exists as a defensive reset for callers that reuse the instance.
  useEffect(() => {
    dispatch({ type: 'sessionChanged' });
  }, [sessionId]);

  // Sync the optimistic override only when the authoritative server title
  // actually changes (e.g. the parent refetches and pushes a new prop). A
  // stable but unrelated prop (failure case: server title stays the same)
  // is intentionally ignored — failure is handled explicitly in `submit`.
  useEffect(() => {
    if (serverTitle === undefined) {
      return;
    }
    if (lastSeenServerTitleRef.current === serverTitle) {
      return;
    }
    lastSeenServerTitleRef.current = serverTitle;
    dispatch({ type: 'serverTitleChanged' });
  }, [serverTitle]);

  const openModal = useCallback(() => {
    dispatch({ type: 'openModal' });
  }, []);

  const closeModal = useCallback(() => {
    dispatch({ type: 'closeModal' });
  }, []);

  const submit = useCallback(
    async (next: string) => {
      // RenameModal already enforces trim + non-empty + changed-input, so
      // whatever reaches here is a real attempted rename. Snapshot the
      // title currently shown in the header (optimistic override if present,
      // otherwise the authoritative/fallback title) so a failure reverts to
      // what the user actually saw, not a stale server title that may lag
      // behind after a prior successful rename.
      const previousTitle = getSessionDetailRenameState({
        fallbackTitle,
        isLoaded,
        serverTitle,
        renameState,
      }).title;
      dispatch({ type: 'submit', nextTitle: next });
      try {
        await renameSessionAsync(sessionId, next);
        // Success: the optimistic title already set by the `submit` event
        // stays in the header until the authoritative server title (or a
        // route change) catches up.
      } catch (error) {
        // Restore the previously displayed title so the header visibly
        // reverts. The mutation's own onError has already toasted and
        // rolled back the list cache; we rethrow so RenameModal keeps the
        // modal open and shows its inline error with the real failure
        // message.
        dispatch({ type: 'submitFailure', previousTitle });
        throw error;
      }
    },
    [fallbackTitle, isLoaded, renameSessionAsync, renameState, serverTitle, sessionId]
  );

  const state = getSessionDetailRenameState({
    fallbackTitle,
    isLoaded,
    serverTitle,
    renameState,
  });

  return {
    title: state.title,
    isTitleInteractive: state.isTitleInteractive,
    isModalOpen: state.isModalOpen,
    modalInitialValue: state.modalInitialValue ?? state.title,
    openModal,
    closeModal,
    submit,
  };
}
