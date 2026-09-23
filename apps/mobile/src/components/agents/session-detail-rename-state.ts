import { i18n } from '@/i18n';
import { sessionDisplayTitle } from '@/lib/session-display-title';

import {
  clearUserSessionTitles as clearStoredUserSessionTitles,
  getUserSessionTitle,
  rememberUserSessionTitle as rememberStoredUserSessionTitle,
  useUserSessionTitlesRevision,
} from './session-user-titles';

export { useUserSessionTitlesRevision };

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
 * The longest session title the rename endpoint accepts, in characters. It
 * mirrors the server's `RenameSessionInputSchema` (`title: z.string().max(200)`
 * in apps/web/src/routers/cli-sessions-v2-router.ts). Every rename surface must
 * allow this many characters: a lower field cap silently drops the rest of the
 * title, and the header then renders a mid-word fragment such as
 * "…verification pa" instead of the title the user typed.
 */
export const SESSION_TITLE_MAX_LENGTH = 200;

/**
 * The title as it may be shown on screen, or undefined when the session has
 * no real title yet. A freshly created session carries a
 * `New session - <ISO timestamp>` placeholder until auto-titling replaces it;
 * the placeholder is an internal marker (the web router normalizes it to
 * null the same way), and rendering it in the header truncates to
 * "New session - 2026-…" instead of showing the title in full. Treat it as
 * untitled so the header keeps its short fallback copy.
 *
 * Shared with every other title surface through `sessionDisplayTitle`
 * (`@/lib/session-display-title`), so the placeholder rule has one owner.
 */
export function displaySessionTitle(title: string | null | undefined): string | undefined {
  return sessionDisplayTitle(title);
}

/**
 * Titles the user set through the app's rename flow, keyed by session id.
 *
 * `sessionDisplayTitle` judges the stored text alone: it can prove only that a
 * title *looks* like the backend's unnamed placeholder, not who wrote it, and
 * the rename API accepts any nonblank title, so a user may choose one that
 * matches. Stored text alone cannot separate the two, so the app records the
 * titles its own rename flow wrote and never hides those as unnamed. The
 * record is durable (hydrated from the encrypted KV at startup), so a chosen
 * title survives a cold relaunch; `clearSessionScopedState` drops it at an
 * account boundary.
 *
 * Only a title `sessionDisplayTitle` would hide needs recording: every other
 * title is already returned as-is by `namedSessionTitle`, so the caller filters
 * before writing and the record stays tiny.
 */
export function rememberUserSessionTitle(sessionId: string, title: string): void {
  const trimmed = title.trim();
  if (trimmed.length === 0 || sessionDisplayTitle(trimmed) !== undefined) {
    return;
  }
  rememberStoredUserSessionTitle(sessionId, trimmed);
}

/**
 * Drop every recorded user title at a sign-out or account switch. The store
 * clears memory synchronously and deletes its KV scope best-effort, so the
 * teardown never awaits a disk write.
 */
export function clearUserSessionTitles(): void {
  void clearStoredUserSessionTitles();
}

/**
 * A title a user should actually see, or undefined when the session has no
 * name: null, blank, or the backend's ISO placeholder — the judgement
 * `sessionDisplayTitle` makes on the stored text. A title the app's own rename
 * flow wrote for `sessionId` is never treated as the placeholder.
 * Callers fall back to the localized unnamed-session name.
 */
export function namedSessionTitle(
  title: string | null | undefined,
  sessionId?: string
): string | undefined {
  const display = sessionDisplayTitle(title);
  if (display !== undefined) {
    return display;
  }
  // `sessionDisplayTitle` sees only the text, so it cannot tell a placeholder
  // the backend seeded from a title the user chose that happens to match it.
  // The recorded title proves the app's own rename flow wrote it.
  const trimmed = title?.trim();
  if (
    trimmed !== undefined &&
    trimmed.length > 0 &&
    sessionId !== undefined &&
    getUserSessionTitle(sessionId) === trimmed
  ) {
    return trimmed;
  }
  return undefined;
}

/**
 * Pure helper that derives the session-detail header display state from the
 * authoritative server title and the reducer state. A backend default title
 * (`New session - <ISO>`) is machine output, so it is treated as no title and
 * the caller's fallback copy shows instead. Pass the session id so a title the
 * user's own rename wrote is not hidden as the backend placeholder.
 *
 * Both the server title and the cached fallback run through the shared title
 * helpers, so the server's creation-default placeholder (`New session -
 * <ISO timestamp>`) can never reach the header or seed the rename field —
 * either would otherwise show a raw timestamp. A missing or placeholder
 * fallback becomes the generic `Session` label. The user's `optimisticTitle`
 * is their own input and is never filtered.
 */
export function getSessionDetailRenameState(input: {
  sessionId?: string;
  fallbackTitle: string;
  isLoaded: boolean;
  serverTitle: string | undefined;
  renameState: RenameState;
}): SessionDetailRenameState {
  const fallbackTitle =
    sessionDisplayTitle(input.fallbackTitle) ?? i18n.t('agentChat.session.title');
  const serverTitle = namedSessionTitle(input.serverTitle, input.sessionId);
  const baseTitle = input.isLoaded ? (serverTitle ?? fallbackTitle) : fallbackTitle;
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
