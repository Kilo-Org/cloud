import { sessionDisplayTitle } from '@/lib/session-display-title';

export type RenameState = {
  isModalOpen: boolean;
  optimisticTitle: string | null;
};

type RenameEvent =
  | { type: 'openModal' }
  | { type: 'closeModal' }
  | { type: 'submit'; nextTitle: string }
  | { type: 'submitFailure'; previousTitle: string }
  | { type: 'serverTitleChanged' }
  | { type: 'sessionChanged' };

export function initialRenameState(): RenameState {
  return { isModalOpen: false, optimisticTitle: null };
}

/**
 * Pure reducer that owns the rename modal and optimistic header title
 * transitions. It is extracted so the full lifecycle stays unit-testable
 * without rendering React Native.
 */
export function renameStateReducer(state: RenameState, event: RenameEvent): RenameState {
  switch (event.type) {
    case 'openModal': {
      return { ...state, isModalOpen: true };
    }
    case 'closeModal': {
      return { ...state, isModalOpen: false };
    }
    case 'submit': {
      return { ...state, optimisticTitle: event.nextTitle };
    }
    case 'submitFailure': {
      return { ...state, optimisticTitle: event.previousTitle };
    }
    case 'serverTitleChanged':
    case 'sessionChanged': {
      return { ...state, isModalOpen: false, optimisticTitle: null };
    }
    default: {
      return state;
    }
  }
}

type SessionDetailRenameState = {
  title: string;
  isTitleInteractive: boolean;
  modalInitialValue: string | null;
  isModalOpen: boolean;
};

/**
 * Pure helper that derives the session-detail header display state from the
 * authoritative server title and the reducer state.
 *
 * The server title — the fetched title, or a live `session.updated` title the
 * hook folds into `serverTitle` — passes through `sessionDisplayTitle`, so the
 * creation placeholder (`New session - <ISO instant>`) can never reach the
 * header from the server. The fallback title is the caller's to sanitize: the
 * screen already routes the cached list title through `sessionDisplayTitle`
 * before passing it here (`session-detail-content.tsx`), so a placeholder
 * cached in the list cannot reach the header either.
 */
export function getSessionDetailRenameState(input: {
  fallbackTitle: string;
  isLoaded: boolean;
  serverTitle: string | undefined;
  renameState: RenameState;
}): SessionDetailRenameState {
  const baseTitle = input.isLoaded
    ? (sessionDisplayTitle(input.serverTitle) ?? input.fallbackTitle)
    : input.fallbackTitle;
  const title = input.renameState.optimisticTitle ?? baseTitle;
  return {
    title,
    isTitleInteractive: input.isLoaded,
    modalInitialValue: input.renameState.isModalOpen ? title : null,
    isModalOpen: input.renameState.isModalOpen,
  };
}

/**
 * Title from a v2 `session.updated` event for this session, or undefined
 * when the event is for another session or carries no usable title.
 */
export function titleFromSessionUpdatedEvent(
  sessionId: string,
  payload: {
    source: string;
    session: { sessionId: string; title: string | null };
  }
): string | undefined {
  if (payload.source !== 'v2' || payload.session.sessionId !== sessionId) {
    return undefined;
  }
  return sessionDisplayTitle(payload.session.title);
}
