import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { confirmStartAgent } from './start-agent-confirmation';

const mocks = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }));

type AlertButton = { text: string; style?: string; onPress?: () => void };

type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };

const REQUEST = { action: 'StartAgent', prompt: 'fix the build' } as const;

function lastAlert(): { buttons: AlertButton[]; options: AlertOptions } {
  const call = mocks.alert.mock.calls.at(-1);
  expect(call).toBeDefined();
  return {
    buttons: (call?.[2] ?? []) as AlertButton[],
    options: (call?.[3] ?? {}) as AlertOptions,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('confirmStartAgent', () => {
  it('names the prompt it is about to run', () => {
    void confirmStartAgent(REQUEST);
    expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
      i18n.t('appActions.start.confirmTitle'),
      i18n.t('appActions.start.confirmMessage', { prompt: 'fix the build' }),
      expect.any(Array),
      expect.objectContaining({ cancelable: true })
    );
  });

  it('names the repository and the session the request targets', () => {
    void confirmStartAgent({
      action: 'StartAgent',
      prompt: 'fix the build',
      repository: 'o/r',
      sessionId: 'ses_1',
    });
    const message = mocks.alert.mock.calls.at(-1)?.[1] as string | undefined;
    expect(message).toContain(
      i18n.t('appActions.start.confirmMessage', { prompt: 'fix the build' })
    );
    expect(message).toContain(`${i18n.t('common.repository')}: o/r`);
    expect(message).toContain(`${i18n.t('agentChat.session.title')}: ses_1`);
  });

  it('answers false for Cancel and true for the start button', async () => {
    const cancelled = confirmStartAgent(REQUEST);
    const cancel = lastAlert().buttons.find(button => button.style === 'cancel');
    expect(cancel?.text).toBe(i18n.t('common.cancel'));
    cancel?.onPress?.();
    await expect(cancelled).resolves.toBe(false);

    const started = confirmStartAgent(REQUEST);
    const start = lastAlert().buttons.find(button => button.text !== i18n.t('common.cancel'));
    expect(start?.text).toBe(i18n.t('agentChat.newSession.startSession'));
    start?.onPress?.();
    await expect(started).resolves.toBe(true);
  });

  it('answers false when the dialog is dismissed', async () => {
    const dismissed = confirmStartAgent(REQUEST);
    lastAlert().options.onDismiss?.();
    await expect(dismissed).resolves.toBe(false);
  });
});
