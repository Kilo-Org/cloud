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
 * The backend's "unnamed" session title is a raw ISO placeholder such as
 * `New session - 2026-09-22T02:05:22.778Z`; web nulls it before display.
 * Mirrors `isDefaultSessionTitle` in
 * `packages/session-ingest-contracts/src/index.ts` and must stay in step with
 * it. The pattern is mirrored rather than imported because mobile does not
 * depend on that package (only `apps/web` consumes it) and
 * `apps/mobile/AGENTS.md` requires `npx expo install` for dependencies, which
 * cannot resolve a private workspace package.
 */
const PLACEHOLDER_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Titles the user set through the app's rename flow, keyed by session id.
 *
 * The placeholder pattern can only prove a title *looks* like the backend's
 * unnamed placeholder; it cannot prove who wrote it, and the rename API accepts
 * any nonblank title, so a user may choose one that matches the pattern. Stored
 * text alone cannot separate the two, so the app records the titles its own
 * rename flow wrote and never hides those as unnamed. Module scope mirrors the
 * other session-scoped stores; `clearSessionScopedState` drops it at an account
 * boundary.
 */
const userRenamedTitles = new Map<string, string>();

/** Record a title the user wrote through the rename flow for one session. */
export function rememberUserSessionTitle(sessionId: string, title: string): void {
  const trimmed = title.trim();
  if (trimmed.length > 0) {
    userRenamedTitles.set(sessionId, trimmed);
  }
}

/** Drop every recorded user title at a sign-out or account switch. */
export function clearUserSessionTitles(): void {
  userRenamedTitles.clear();
}

/**
 * A title a user should actually see, or undefined when the session has no
 * name: null, blank, or the backend's ISO placeholder. A title the app's own
 * rename flow wrote for `sessionId` is never treated as the placeholder.
 * Callers fall back to the localized unnamed-session name.
 */
export function namedSessionTitle(
  title: string | null | undefined,
  sessionId?: string
): string | undefined {
  if (title == null) {
    return undefined;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    PLACEHOLDER_SESSION_TITLE_PATTERN.test(trimmed) &&
    !(sessionId !== undefined && userRenamedTitles.get(sessionId) === trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Pure helper that derives the session-detail header display state from the
 * authoritative server title and the reducer state. Pass the session id so a
 * title the user's own rename wrote is not hidden as the backend placeholder.
 */
export function getSessionDetailRenameState(input: {
  sessionId?: string;
  fallbackTitle: string;
  isLoaded: boolean;
  serverTitle: string | undefined;
  renameState: RenameState;
}): SessionDetailRenameState {
  const serverTitle = namedSessionTitle(input.serverTitle, input.sessionId);
  const baseTitle = input.isLoaded ? (serverTitle ?? input.fallbackTitle) : input.fallbackTitle;
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
  return namedSessionTitle(payload.session.title, sessionId);
}
