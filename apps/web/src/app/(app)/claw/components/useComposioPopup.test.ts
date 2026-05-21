import {
  COMPOSIO_CONFIRMATION_TIMEOUT_MS,
  createComposioPopupStateMachine,
  type ComposioPopupState,
} from './useComposioPopup';

function createPopup() {
  const popup = {
    closed: false,
    location: { href: 'about:blank' },
    // Tests make close synchronous for easy assertions; production browsers
    // may flip `closed` later, but the state machine does not rely on that.
    close: jest.fn(() => {
      popup.closed = true;
    }),
  };
  return popup as unknown as Window & typeof popup;
}

function createHarness() {
  const transitions: ComposioPopupState[] = [];
  const clearedTimeouts: number[] = [];
  let timeoutCallback: (() => void) | null = null;
  let timeoutMs: number | null = null;
  const onConfirmed = jest.fn();
  const onFailed = jest.fn();
  const refetchStatus = jest.fn(async () => undefined);
  const machine = createComposioPopupStateMachine({
    transition: state => transitions.push(state),
    onConfirmed,
    onFailed,
    refetchStatus,
    setConfirmationTimeout: (callback, ms) => {
      timeoutCallback = callback;
      timeoutMs = ms;
      return 123;
    },
    clearConfirmationTimeout: timeoutId => clearedTimeouts.push(timeoutId),
  });

  return {
    machine,
    transitions,
    clearedTimeouts,
    get timeoutCallback() {
      return timeoutCallback;
    },
    get timeoutMs() {
      return timeoutMs;
    },
    onConfirmed,
    onFailed,
    refetchStatus,
  };
}

describe('createComposioPopupStateMachine', () => {
  it('transitions through popup success and status confirmation', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    harness.machine.setRedirect('https://composio.example/connect');
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });
    harness.machine.confirmConnected();

    expect(harness.transitions.map(state => state.kind)).toEqual([
      'opening',
      'awaiting-callback',
      'awaiting-confirmation',
      'idle',
    ]);
    expect(popup.location.href).toBe('https://composio.example/connect');
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(harness.refetchStatus).toHaveBeenCalledTimes(1);
    expect(harness.timeoutMs).toBe(COMPOSIO_CONFIRMATION_TIMEOUT_MS);
    expect(harness.clearedTimeouts).toEqual([123]);
    expect(harness.onConfirmed).toHaveBeenCalledTimes(1);
    expect(harness.onFailed).not.toHaveBeenCalled();
  });

  it('fails with popup_closed after three consecutive closed observations', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    popup.closed = true;
    harness.machine.observePopupClosed();
    harness.machine.observePopupClosed();
    expect(harness.machine.getState().kind).toBe('opening');

    harness.machine.observePopupClosed();

    expect(harness.machine.getState()).toEqual({ kind: 'failed', reason: 'popup_closed' });
    expect(harness.refetchStatus).toHaveBeenCalledTimes(1);
    expect(harness.onFailed).toHaveBeenCalledWith('popup_closed');
  });

  it('fails with confirmation_timeout when status never confirms', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    harness.machine.setRedirect('https://composio.example/connect');
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });
    harness.timeoutCallback?.();

    expect(harness.machine.getState()).toEqual({
      kind: 'failed',
      reason: 'confirmation_timeout',
    });
    expect(harness.onFailed).toHaveBeenCalledWith('confirmation_timeout');
    expect(harness.onConfirmed).not.toHaveBeenCalled();
  });

  it('ignores callback messages for a different attempt id', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    harness.machine.setRedirect('https://composio.example/connect');
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-2' });

    expect(harness.machine.getState().kind).toBe('awaiting-callback');
    expect(popup.close).not.toHaveBeenCalled();
    expect(harness.refetchStatus).not.toHaveBeenCalled();
  });

  it('accepts a callback result while still in opening state', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });

    expect(harness.machine.getState()).toEqual({
      kind: 'awaiting-confirmation',
      attemptId: 'attempt-1',
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(harness.refetchStatus).toHaveBeenCalledTimes(1);
  });

  it('dedupes repeated result deliveries across callback channels', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    harness.machine.setRedirect('https://composio.example/connect');
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });
    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });
    harness.machine.handleResult({ result: 'failed', attemptId: 'attempt-1' });

    expect(harness.machine.getState().kind).toBe('awaiting-confirmation');
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(harness.refetchStatus).toHaveBeenCalledTimes(1);
    expect(harness.onFailed).not.toHaveBeenCalled();
  });

  it('does not redirect after popup_closed wins the link creation race', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    popup.closed = true;
    harness.machine.observePopupClosed();
    harness.machine.observePopupClosed();
    harness.machine.observePopupClosed();

    harness.machine.setRedirect('https://composio.example/connect');

    expect(harness.machine.getState()).toEqual({ kind: 'failed', reason: 'popup_closed' });
    expect(popup.location.href).toBe('about:blank');
  });

  it('accepts a late success callback after popup_closed for the same attempt', () => {
    const harness = createHarness();
    const popup = createPopup();

    harness.machine.open({ attemptId: 'attempt-1', popup });
    popup.closed = true;
    harness.machine.observePopupClosed();
    harness.machine.observePopupClosed();
    harness.machine.observePopupClosed();

    harness.machine.handleResult({ result: 'success', attemptId: 'attempt-1' });

    expect(harness.machine.getState()).toEqual({
      kind: 'awaiting-confirmation',
      attemptId: 'attempt-1',
    });
    expect(harness.refetchStatus).toHaveBeenCalledTimes(2);
    expect(harness.onFailed).toHaveBeenCalledWith('popup_closed');
  });
});
