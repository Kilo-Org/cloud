'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const COMPOSIO_CONFIRMATION_TIMEOUT_MS = 45_000;

const COMPOSIO_POPUP_RESULT_STORAGE_KEY = 'kiloclaw:composio-connect-result';
const COMPOSIO_POPUP_BROADCAST_CHANNEL = 'kiloclaw:composio-connect';
// Reuse the same named window for repeated clicks in one tab instead of
// leaving multiple OAuth popups open if the user double-clicks Connect.
const COMPOSIO_POPUP_NAME = 'kiloclaw-composio-connect';
const COMPOSIO_POPUP_FEATURES = 'popup,width=520,height=720';

export type ComposioPopupFailureReason =
  | 'popup_closed'
  | 'connection_failed'
  | 'confirmation_timeout';

export type ComposioPopupState =
  | { kind: 'idle' }
  | { kind: 'opening'; attemptId: string; popup: Window }
  | { kind: 'awaiting-callback'; attemptId: string; popup: Window }
  | { kind: 'awaiting-confirmation'; attemptId: string }
  | { kind: 'failed'; reason: ComposioPopupFailureReason };

type ComposioPopupMessage = {
  type: 'kiloclaw:composio-connect';
  result: 'success' | 'failed' | 'unknown';
  attemptId: string;
};

type ComposioConnectionStatus = 'not_configured' | 'disconnected' | 'connected';

type ComposioPopupStateMachineOptions = {
  transition: (state: ComposioPopupState) => void;
  onConfirmed: () => void;
  onFailed: (reason: ComposioPopupFailureReason) => void;
  refetchStatus: () => Promise<unknown>;
  setConfirmationTimeout: (callback: () => void, ms: number) => number;
  clearConfirmationTimeout: (timeoutId: number) => void;
};

export function createComposioConnectAttemptId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function writeComposioPopupLoadingPage(popup: Window) {
  popup.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Preparing Google Calendar connection</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: oklch(0.145 0 0);
        color: oklch(0.985 0 0);
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      main {
        width: min(360px, calc(100vw - 48px));
        border: 1px solid oklch(1 0 0 / 0.1);
        border-radius: 14px;
        background: oklch(0.205 0 0);
        padding: 24px;
      }
      .eyebrow {
        color: oklch(0.95 0.15 108);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 10px 0 8px;
        font-size: 20px;
        line-height: 1.25;
      }
      p {
        margin: 0;
        color: oklch(0.708 0 0);
        font-size: 14px;
        line-height: 1.5;
      }
      .dot {
        width: 8px;
        height: 8px;
        margin-top: 18px;
        border-radius: 999px;
        background: oklch(0.95 0.15 108);
        animation: pulse 1s ease-out infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 0.35; transform: scale(0.85); }
        50% { opacity: 1; transform: scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dot { animation: none; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">KiloClaw</div>
      <h1>Preparing Google Calendar connection</h1>
      <p>Keep this window open. Google approval will load here, then Kilo will return you to onboarding.</p>
      <div class="dot" aria-hidden="true"></div>
    </main>
  </body>
</html>`);
  popup.document.close();
}

function isComposioPopupMessage(value: unknown): value is ComposioPopupMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'kiloclaw:composio-connect' &&
    (candidate.result === 'success' ||
      candidate.result === 'failed' ||
      candidate.result === 'unknown') &&
    typeof candidate.attemptId === 'string' &&
    candidate.attemptId.length > 0
  );
}

function isPendingState(state: ComposioPopupState): boolean {
  return (
    state.kind === 'opening' ||
    state.kind === 'awaiting-callback' ||
    state.kind === 'awaiting-confirmation'
  );
}

function shouldListenForStoredResult(state: ComposioPopupState): boolean {
  return isPendingState(state) || (state.kind === 'failed' && state.reason === 'popup_closed');
}

export function createComposioPopupStateMachine({
  transition,
  onConfirmed,
  onFailed,
  refetchStatus,
  setConfirmationTimeout,
  clearConfirmationTimeout,
}: ComposioPopupStateMachineOptions) {
  let state: ComposioPopupState = { kind: 'idle' };
  let activeAttemptId: string | null = null;
  let handledAttemptId: string | null = null;
  let confirmationTimeoutId: number | null = null;
  let closedChecks = 0;

  function setMachineState(nextState: ComposioPopupState) {
    state = nextState;
    transition(nextState);
  }

  function clearPendingConfirmationTimeout() {
    if (confirmationTimeoutId === null) return;
    clearConfirmationTimeout(confirmationTimeoutId);
    confirmationTimeoutId = null;
  }

  function closePopup() {
    if (state.kind === 'opening' || state.kind === 'awaiting-callback') {
      state.popup.close();
    }
  }

  function fail(reason: ComposioPopupFailureReason) {
    closePopup();
    clearPendingConfirmationTimeout();
    closedChecks = 0;
    setMachineState({ kind: 'failed', reason });
    onFailed(reason);
  }

  return {
    getState: () => state,

    open({ attemptId, popup }: { attemptId: string; popup: Window }) {
      closePopup();
      clearPendingConfirmationTimeout();
      activeAttemptId = attemptId;
      handledAttemptId = null;
      closedChecks = 0;
      setMachineState({ kind: 'opening', attemptId, popup });
    },

    setRedirect(redirectUrl: string) {
      if (state.kind !== 'opening') return;
      state.popup.location.href = redirectUrl;
      closedChecks = 0;
      setMachineState({
        kind: 'awaiting-callback',
        attemptId: state.attemptId,
        popup: state.popup,
      });
    },

    handleResult(message: { result: 'success' | 'failed' | 'unknown'; attemptId: string }) {
      // Accept `opening` too: popup callbacks can theoretically arrive before
      // the mutation success handler transitions us to `awaiting-callback`.
      const acceptsResult =
        (state.kind === 'opening' || state.kind === 'awaiting-callback') &&
        message.attemptId === state.attemptId;
      const acceptsLateClosedResult =
        state.kind === 'failed' &&
        state.reason === 'popup_closed' &&
        message.attemptId === activeAttemptId;
      if (!acceptsResult && !acceptsLateClosedResult) return;
      if (handledAttemptId === message.attemptId) return;
      handledAttemptId = message.attemptId;
      closedChecks = 0;
      closePopup();
      void refetchStatus();

      if (message.result !== 'success') {
        fail('connection_failed');
        return;
      }

      clearPendingConfirmationTimeout();
      setMachineState({ kind: 'awaiting-confirmation', attemptId: message.attemptId });
      confirmationTimeoutId = setConfirmationTimeout(() => {
        if (state.kind !== 'awaiting-confirmation') return;
        if (state.attemptId !== message.attemptId) return;
        confirmationTimeoutId = null;
        fail('confirmation_timeout');
      }, COMPOSIO_CONFIRMATION_TIMEOUT_MS);
    },

    observePopupClosed() {
      if (state.kind !== 'opening' && state.kind !== 'awaiting-callback') return;
      if (!state.popup.closed) {
        closedChecks = 0;
        return;
      }

      closedChecks += 1;
      if (closedChecks < 3) return;
      void refetchStatus();
      fail('popup_closed');
    },

    confirmConnected() {
      if (state.kind !== 'awaiting-confirmation') return;
      clearPendingConfirmationTimeout();
      handledAttemptId = null;
      activeAttemptId = null;
      closedChecks = 0;
      setMachineState({ kind: 'idle' });
      onConfirmed();
    },

    cancel() {
      closePopup();
      clearPendingConfirmationTimeout();
      activeAttemptId = null;
      handledAttemptId = null;
      closedChecks = 0;
      setMachineState({ kind: 'idle' });
    },
  };
}

export function useComposioPopup({
  onConfirmed,
  onFailed,
  refetchStatus,
  connectionStatus,
}: {
  onConfirmed: () => void;
  onFailed: (reason: ComposioPopupFailureReason) => void;
  refetchStatus: () => Promise<unknown>;
  connectionStatus: ComposioConnectionStatus | undefined;
}) {
  const [state, setState] = useState<ComposioPopupState>({ kind: 'idle' });
  const callbacksRef = useRef({ onConfirmed, onFailed, refetchStatus });
  callbacksRef.current = { onConfirmed, onFailed, refetchStatus };
  const machineRef = useRef<ReturnType<typeof createComposioPopupStateMachine> | null>(null);

  if (machineRef.current === null) {
    machineRef.current = createComposioPopupStateMachine({
      transition: setState,
      onConfirmed: () => callbacksRef.current.onConfirmed(),
      onFailed: reason => callbacksRef.current.onFailed(reason),
      refetchStatus: () => callbacksRef.current.refetchStatus(),
      setConfirmationTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearConfirmationTimeout: timeoutId => window.clearTimeout(timeoutId),
    });
  }

  const machine = machineRef.current;

  const cancel = useCallback(() => {
    machine.cancel();
  }, [machine]);

  const open = useCallback(
    ({ attemptId }: { attemptId: string }): Window | null => {
      cancel();
      const popup = window.open('about:blank', COMPOSIO_POPUP_NAME, COMPOSIO_POPUP_FEATURES);
      if (!popup) return null;
      writeComposioPopupLoadingPage(popup);
      machine.open({ attemptId, popup });
      return popup;
    },
    [cancel, machine]
  );

  const setRedirect = useCallback(
    (redirectUrl: string) => {
      machine.setRedirect(redirectUrl);
    },
    [machine]
  );

  const handleResult = useCallback(
    (message: { result: 'success' | 'failed' | 'unknown'; attemptId: string }) => {
      machine.handleResult(message);
    },
    [machine]
  );

  const handleStoredResult = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(COMPOSIO_POPUP_RESULT_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isComposioPopupMessage(parsed)) return;
      handleResult(parsed);
    } catch {
      return;
    }
  }, [handleResult]);

  useEffect(() => {
    // React strict-mode runs the initial mount cleanup in dev; callers only
    // open popups from user actions, so the first cleanup cancels idle state.
    return () => machine.cancel();
  }, [machine]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!isComposioPopupMessage(event.data)) return;
      handleResult(event.data);
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleResult]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== COMPOSIO_POPUP_RESULT_STORAGE_KEY || !event.newValue) return;
      try {
        const parsed: unknown = JSON.parse(event.newValue);
        if (!isComposioPopupMessage(parsed)) return;
        handleResult(parsed);
      } catch {
        return;
      }
    }

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [handleResult]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(COMPOSIO_POPUP_BROADCAST_CHANNEL);
    channel.onmessage = event => {
      if (!isComposioPopupMessage(event.data)) return;
      handleResult(event.data);
    };
    return () => channel.close();
  }, [handleResult]);

  useEffect(() => {
    if (state.kind !== 'opening' && state.kind !== 'awaiting-callback') return;

    const intervalId = window.setInterval(() => {
      machine.observePopupClosed();
    }, 700);

    return () => window.clearInterval(intervalId);
  }, [machine, state.kind]);

  useEffect(() => {
    if (!shouldListenForStoredResult(state)) return;

    function refetchComposioStatus() {
      handleStoredResult();
      void refetchStatus();
    }

    window.addEventListener('focus', refetchComposioStatus);
    document.addEventListener('visibilitychange', refetchComposioStatus);
    return () => {
      window.removeEventListener('focus', refetchComposioStatus);
      document.removeEventListener('visibilitychange', refetchComposioStatus);
    };
  }, [handleStoredResult, refetchStatus, state]);

  useEffect(() => {
    if (state.kind !== 'awaiting-confirmation') return;
    if (connectionStatus !== 'connected') return;

    machine.confirmConnected();
  }, [connectionStatus, machine, state.kind]);

  return {
    state,
    isPending: isPendingState(state),
    open,
    setRedirect,
    cancel,
  };
}
