/**
 * Store Module
 *
 * Manages project state using a simple pub/sub pattern.
 * Designed to work with React's useSyncExternalStore.
 *
 * Batches rapid state updates (e.g., from WebSocket reconnect replaying many messages)
 * to prevent excessive React re-renders. Updates are batched until the next animation
 * frame, coalescing all changes that happen before the browser paints.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import type { ProjectState, ProjectStore, StateListener } from './types';

/**
 * Creates an initial project state.
 */
export function createInitialState(
  messages: CloudMessage[],
  deploymentId: string | null,
  modelId: string | null
): ProjectState {
  return {
    messages,
    isStreaming: false,
    isInterrupting: false,
    previewUrl: null,
    previewStatus: 'idle',
    deploymentId,
    model: modelId ?? 'anthropic/claude-sonnet-4',
    currentIframeUrl: null,
  };
}

/**
 * Creates a project store for managing state.
 *
 * Implements frame-based batched notifications: multiple setState calls are batched
 * until the next animation frame, then a single notification is fired. This works
 * for both:
 * - Multiple calls in the same event loop tick (synchronous)
 * - Multiple calls across event loop ticks (e.g., rapid WebSocket messages)
 *
 * The batching window ends when the browser is ready to paint, ensuring all updates
 * that arrive before a frame are combined into a single React re-render.
 *
 * In test/SSR environments without requestAnimationFrame, falls back to setTimeout(0).
 */
export function createProjectStore(initialState: ProjectState): ProjectStore {
  let state = initialState;
  const listeners = new Set<StateListener>();
  let notificationPending = false;

  // Use requestAnimationFrame in browser, setTimeout in tests/SSR
  const hasRAF = typeof requestAnimationFrame === 'function';

  function scheduleNotification(): void {
    if (notificationPending) {
      return;
    }
    notificationPending = true;

    const notify = () => {
      notificationPending = false;
      listeners.forEach(listener => listener());
    };

    if (hasRAF) {
      requestAnimationFrame(notify);
    } else {
      setTimeout(notify, 0);
    }
  }

  function getState(): ProjectState {
    return state;
  }

  function setState(partial: Partial<ProjectState>): void {
    state = { ...state, ...partial };
    scheduleNotification();
  }

  function subscribe(listener: StateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function updateMessages(updater: (messages: CloudMessage[]) => CloudMessage[]): void {
    const newMessages = updater(state.messages);
    setState({ messages: newMessages });
  }

  return {
    getState,
    setState,
    subscribe,
    updateMessages,
  };
}
