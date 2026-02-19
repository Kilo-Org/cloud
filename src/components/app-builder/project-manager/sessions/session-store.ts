/**
 * Generic session store with RAF-batched notifications.
 *
 * Shared by V1 (CloudMessage[]) and V2 (StoredMessage[]) sessions.
 * Batches rapid state updates (e.g. WebSocket reconnect replaying many messages)
 * into a single notification per animation frame.
 * Falls back to setTimeout(0) in test/SSR environments without requestAnimationFrame.
 */

export type SessionState<TMessage> = {
  messages: TMessage[];
  isStreaming: boolean;
};

export type SessionStore<TMessage> = {
  getState: () => SessionState<TMessage>;
  setState: (partial: Partial<SessionState<TMessage>>) => void;
  subscribe: (listener: () => void) => () => void;
  updateMessages: (updater: (messages: TMessage[]) => TMessage[]) => void;
};

export function createSessionStore<TMessage>(initialMessages: TMessage[]): SessionStore<TMessage> {
  let state: SessionState<TMessage> = {
    messages: initialMessages,
    isStreaming: false,
  };

  const listeners = new Set<() => void>();
  let notificationPending = false;

  const hasRAF = typeof requestAnimationFrame === 'function';

  function scheduleNotification(): void {
    if (notificationPending) return;
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

  function getState(): SessionState<TMessage> {
    return state;
  }

  function setState(partial: Partial<SessionState<TMessage>>): void {
    state = { ...state, ...partial };
    scheduleNotification();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function updateMessages(updater: (messages: TMessage[]) => TMessage[]): void {
    setState({ messages: updater(state.messages) });
  }

  return { getState, setState, subscribe, updateMessages };
}
