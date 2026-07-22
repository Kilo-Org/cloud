import { type AlertButton } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showRemoteSessionExitConfirmation } from '@/components/agents/remote-session-exit-alert';
import { confirmRemoteSessionExit } from '@/components/agents/remote-session-exit-confirmation';

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn<(_title: string, _message: string, buttons: AlertButton[]) => void>(),
}));

vi.mock('react-native', () => ({ Alert: { alert: reactNativeMock.alert } }));

describe('showRemoteSessionExitConfirmation', () => {
  beforeEach(() => {
    reactNativeMock.alert.mockReset();
  });

  it('uses the exact native destructive Alert configuration', () => {
    void showRemoteSessionExitConfirmation();

    expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);
    expect(reactNativeMock.alert).toHaveBeenCalledWith(
      'Exit session?',
      'This stops the running session but keeps its history.',
      [
        { text: 'Keep session running', style: 'cancel', onPress: expect.any(Function) },
        { text: 'Exit session', style: 'destructive', onPress: expect.any(Function) },
      ],
      { cancelable: true, onDismiss: expect.any(Function) }
    );
  });

  it('settles once when destructive callbacks fire more than once', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });
    const confirmation = showRemoteSessionExitConfirmation();
    const buttons = reactNativeMock.alert.mock.calls[0]?.[2];

    buttons?.[1]?.onPress?.();
    buttons?.[1]?.onPress?.();

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return confirmation;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('confirmRemoteSessionExit', () => {
  it('returns cancelled without exiting', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return false;
      }, exit)
    ).resolves.toBe('cancelled');
    expect(exit).not.toHaveBeenCalled();
  });

  it('calls exit once and returns accepted after it settles', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return true;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates exit failure', async () => {
    const error = new Error('Upgrade the CLI first');

    await expect(
      confirmRemoteSessionExit(
        async () => {
          await Promise.resolve();
          return true;
        },
        async () => {
          await Promise.resolve();
          throw error;
        }
      )
    ).rejects.toBe(error);
  });
});
