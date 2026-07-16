import { type AlertButton } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmRemoteCliExit } from '@/components/agents/remote-cli-exit-confirmation';
import { showRemoteCliExitConfirmation } from '@/components/agents/remote-cli-exit-alert';

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn<(_title: string, _message: string, buttons: AlertButton[]) => void>(),
}));

vi.mock('react-native', () => ({ Alert: { alert: reactNativeMock.alert } }));

describe('showRemoteCliExitConfirmation', () => {
  beforeEach(() => {
    reactNativeMock.alert.mockReset();
  });

  it('uses the exact native destructive Alert configuration', () => {
    void showRemoteCliExitConfirmation();

    expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);
    expect(reactNativeMock.alert).toHaveBeenCalledWith(
      'Exit CLI?',
      'This will stop the CLI on your computer and take all sessions connected to it offline.',
      [
        { text: 'Keep CLI running', style: 'cancel', onPress: expect.any(Function) },
        { text: 'Exit CLI', style: 'destructive', onPress: expect.any(Function) },
      ],
      { cancelable: true, onDismiss: expect.any(Function) }
    );
  });

  it('settles once when destructive callbacks fire more than once', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });
    const confirmation = showRemoteCliExitConfirmation();
    const buttons = reactNativeMock.alert.mock.calls[0]?.[2];

    buttons?.[1]?.onPress?.();
    buttons?.[1]?.onPress?.();

    await expect(
      confirmRemoteCliExit(async () => {
        await Promise.resolve();
        return confirmation;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('confirmRemoteCliExit', () => {
  it('returns cancelled without exiting', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });

    await expect(
      confirmRemoteCliExit(async () => {
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
      confirmRemoteCliExit(async () => {
        await Promise.resolve();
        return true;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates exit failure', async () => {
    const error = new Error('Upgrade the CLI first');

    await expect(
      confirmRemoteCliExit(
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
