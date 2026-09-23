import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmSettingChange } from './confirm';

const alertMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => void>());
vi.mock('react-native', () => ({ Alert: { alert: alertMock } }));

type AlertButton = Readonly<{ text?: string; style?: string; onPress?: () => void }>;
type AlertOptions = Readonly<{ cancelable?: boolean; onDismiss?: () => void }>;

function lastButtons(): AlertButton[] {
  const buttons = alertMock.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
  return buttons ?? [];
}

function lastOptions(): AlertOptions | undefined {
  return alertMock.mock.calls.at(-1)?.[3] as AlertOptions | undefined;
}

beforeEach(() => {
  alertMock.mockClear();
});

describe('confirmSettingChange', () => {
  it('shows the summary and the cancel/save pair', async () => {
    const pending = Effect.runPromise(confirmSettingChange('Replace the trusted-host list?'));
    const buttons = lastButtons();

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]?.[1]).toBe('Replace the trusted-host list?');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.style).toBe('cancel');

    buttons[1]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the user cancels', async () => {
    const pending = Effect.runPromise(confirmSettingChange('Replace the trusted-host list?'));
    lastButtons()[0]?.onPress?.();
    await expect(pending).resolves.toBe(false);
  });

  it('resolves true when the user confirms', async () => {
    const pending = Effect.runPromise(confirmSettingChange('Replace the trusted-host list?'));
    lastButtons()[1]?.onPress?.();
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the alert is dismissed', async () => {
    const pending = Effect.runPromise(confirmSettingChange('Replace the trusted-host list?'));
    lastOptions()?.onDismiss?.();
    await expect(pending).resolves.toBe(false);
  });

  it('is not cancelable by an outside tap', async () => {
    const pending = Effect.runPromise(confirmSettingChange('Replace the trusted-host list?'));
    expect(lastOptions()?.cancelable).toBe(false);
    lastOptions()?.onDismiss?.();
    await expect(pending).resolves.toBe(false);
  });
});
