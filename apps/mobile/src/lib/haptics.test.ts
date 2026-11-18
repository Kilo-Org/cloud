import { beforeEach, describe, expect, it, vi } from 'vitest';

import { impactHaptic, notificationHaptic, selectionHaptic } from './haptics';

const haptics = vi.hoisted(() => ({
  selectionAsync: vi.fn<() => Promise<void>>(),
  impactAsync: vi.fn<(style: string) => Promise<void>>(),
  notificationAsync: vi.fn<(type: string) => Promise<void>>(),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: haptics.selectionAsync,
  impactAsync: haptics.impactAsync,
  notificationAsync: haptics.notificationAsync,
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

describe('haptics', () => {
  beforeEach(() => {
    // A call recorded in the previous case must not satisfy this one's assertion.
    vi.clearAllMocks();
  });

  it('contains a rejected selection tick instead of leaving it unhandled', async () => {
    haptics.selectionAsync.mockRejectedValue(new Error('no haptic engine'));
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    try {
      process.on('unhandledRejection', onUnhandledRejection);
      expect(() => {
        selectionHaptic();
      }).not.toThrow();
      expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
      // One macrotask, the turn Node flags an unhandled rejection in.
      const flushed = Promise.withResolvers<undefined>();
      setImmediate(() => {
        flushed.resolve(undefined);
      });
      await flushed.promise;
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('contains a native call that throws before returning a promise', () => {
    haptics.impactAsync.mockImplementation(() => {
      throw new Error('native module missing');
    });
    haptics.notificationAsync.mockImplementation(() => {
      throw new Error('native module missing');
    });

    expect(() => {
      impactHaptic('light' as never);
    }).not.toThrow();
    expect(() => {
      notificationHaptic('success' as never);
    }).not.toThrow();
    // A throwing implementation still records its call, so these prove dispatch.
    expect(haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(haptics.notificationAsync).toHaveBeenCalledWith('success');
  });
});
