import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { useSyncExternalStore } from 'react';

/**
 * The session a long-press preview is showing. The target carries everything
 * the overlay and its action panel render, so the owning list row does not
 * have to stay in the render path while the preview is open.
 */
export type SessionPreviewTarget = {
  sessionId: string;
  /** The row's display title, already localized. */
  title: string;
  /** The row's `renameInitialValue`, seeded into the rename prompt. */
  initialRenameValue: string;
  /** Tray row / activeSessionIds member. */
  live: boolean;
  statusKind: GlanceableStatusKind | null;
  needsInput: boolean;
  totalCostMicrodollars: number | null;
  /** Absent → no Rename item. */
  onRename?: (newTitle: string) => void;
  /** Absent → no Delete item. */
  onDelete?: () => void;
  /** Absent → no Exit item. */
  onExit?: () => void;
};

/**
 * Controls when the preview overlay is mounted and when it is visible. Keeping
 * the target after close lets `visible` transition true → false so the exit
 * animation runs before the target is released.
 */
export type SessionPreviewState = {
  target: SessionPreviewTarget | null;
  visible: boolean;
};

export const CLOSED_SESSION_PREVIEW: SessionPreviewState = { target: null, visible: false };

export function openSessionPreview(
  _current: SessionPreviewState,
  next: SessionPreviewTarget
): SessionPreviewState {
  return { target: next, visible: true };
}

/** Keeps the target mounted with `visible: false` so the close animation runs. */
export function closeSessionPreview(current: SessionPreviewState): SessionPreviewState {
  if (!current.visible) {
    return current;
  }
  return { target: current.target, visible: false };
}

/**
 * Release the target after the dismiss animation finishes. Callers schedule
 * this from the close callback. A visible preview is never released: if a
 * reopen landed before the scheduled release runs, the reopen wins and the
 * release is a no-op. The state object is returned unchanged in that case, so
 * `useSyncExternalStore` sees no change.
 */
export function releaseSessionPreview(current: SessionPreviewState): SessionPreviewState {
  if (!current.target || current.visible) {
    return current;
  }
  return { target: null, visible: false };
}

// The module-level store. The state object is replaced only when a transition
// actually changes it, so `getSessionPreviewSnapshot` keeps a stable identity
// while nothing changes — the `useSyncExternalStore` identity contract.
let state: SessionPreviewState = CLOSED_SESSION_PREVIEW;
const listeners = new Set<() => void>();

/** `useSyncExternalStore` getSnapshot. Stable while the state is unchanged. */
export function getSessionPreviewSnapshot(): SessionPreviewState {
  return state;
}

/** `useSyncExternalStore` subscribe. */
export function subscribeSessionPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSessionPreviewState(next: SessionPreviewState): void {
  if (next === state) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function openSessionPreviewStore(next: SessionPreviewTarget): void {
  setSessionPreviewState(openSessionPreview(state, next));
}

export function closeSessionPreviewStore(): void {
  setSessionPreviewState(closeSessionPreview(state));
}

export function releaseSessionPreviewStore(): void {
  setSessionPreviewState(releaseSessionPreview(state));
}

export function useSessionPreview(): SessionPreviewState {
  return useSyncExternalStore(subscribeSessionPreview, getSessionPreviewSnapshot);
}
