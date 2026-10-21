import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { confirmStartAgent } from './start-agent-confirmation';

const native = vi.hoisted(() => ({
  alert: vi.fn(),
  appState: { currentState: 'active' as string },
  addEventListener: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: native.alert },
  AppState: {
    addEventListener: native.addEventListener,
    get currentState() {
      return native.appState.currentState;
    },
  },
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };

type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };

const REQUEST = { action: 'StartAgent', prompt: 'fix the build' } as const;

function lastAlert(): { buttons: AlertButton[]; options: AlertOptions } {
  const call = native.alert.mock.calls.at(-1);
  expect(call).toBeDefined();
  return {
    buttons: (call?.[2] ?? []) as AlertButton[],
    options: (call?.[3] ?? {}) as AlertOptions,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.appState.currentState = 'active';
});

describe('confirmStartAgent', () => {
  it('names the prompt it is about to run', async () => {
    void confirmStartAgent(REQUEST);
    await Promise.resolve();
    expect(native.alert).toHaveBeenCalledExactlyOnceWith(
      i18n.t('appActions.start.confirmTitle'),
      i18n.t('appActions.start.confirmMessage', { prompt: 'fix the build' }),
      expect.any(Array),
      expect.objectContaining({ cancelable: true })
    );
  });

  it('names the repository and the session the request targets', async () => {
    void confirmStartAgent({
      action: 'StartAgent',
      prompt: 'fix the build',
      repository: 'o/r',
      sessionId: 'ses_1',
    });
    await Promise.resolve();
    const message = native.alert.mock.calls.at(-1)?.[1] as string | undefined;
    expect(message).toContain(
      i18n.t('appActions.start.confirmMessage', { prompt: 'fix the build' })
    );
    expect(message).toContain(`${i18n.t('common.repository')}: o/r`);
    expect(message).toContain(`${i18n.t('agentChat.session.title')}: ses_1`);
  });

  it('waits until the app is in front before asking', async () => {
    native.appState.currentState = 'background';
    const remove = vi.fn();
    const listeners: ((state: string) => void)[] = [];
    native.addEventListener.mockImplementation(
      (_event: string, listener: (state: string) => void) => {
        listeners.push(listener);
        return { remove };
      }
    );
    const answered = confirmStartAgent(REQUEST);
    await Promise.resolve();
    expect(native.alert).not.toHaveBeenCalled();
    native.appState.currentState = 'active';
    listeners[0]?.('active');
    await vi.waitFor(() => {
      expect(native.alert).toHaveBeenCalledOnce();
    });
    expect(remove).toHaveBeenCalledOnce();
    lastAlert()
      .buttons.find(button => button.text === i18n.t('common.cancel'))
      ?.onPress?.();
    await expect(answered).resolves.toBe(false);
  });

  it('answers false and releases the listener when the app never comes forward', async () => {
    vi.useFakeTimers();
    native.appState.currentState = 'background';
    const remove = vi.fn();
    native.addEventListener.mockImplementation(() => ({ remove }));
    const answered = confirmStartAgent(REQUEST);
    expect(native.alert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(answered).resolves.toBe(false);
    expect(native.alert).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('answers false for Cancel and true for the start button', async () => {
    const cancelled = confirmStartAgent(REQUEST);
    await Promise.resolve();
    const cancel = lastAlert().buttons.find(button => button.style === 'cancel');
    expect(cancel?.text).toBe(i18n.t('common.cancel'));
    cancel?.onPress?.();
    await expect(cancelled).resolves.toBe(false);

    const started = confirmStartAgent(REQUEST);
    await Promise.resolve();
    const start = lastAlert().buttons.find(button => button.text !== i18n.t('common.cancel'));
    expect(start?.text).toBe(i18n.t('agentChat.newSession.startSession'));
    start?.onPress?.();
    await expect(started).resolves.toBe(true);
  });

  it('answers false when the dialog is dismissed', async () => {
    const dismissed = confirmStartAgent(REQUEST);
    await Promise.resolve();
    lastAlert().options.onDismiss?.();
    await expect(dismissed).resolves.toBe(false);
  });
});
