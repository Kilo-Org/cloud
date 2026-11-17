// The Manage-access control's watchdog: after it releases the control a second
// tap may supersede the attempt, and only the attempt that still owns the
// control may deliver the return edge its caller resyncs from. Mocks and
// mounting live in the helpers module, whose import MUST stay first: it
// registers the module mocks while it is evaluated.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';

import {
  accessMocks,
  mountHook,
  requireHook,
  resetAccessMocks,
} from './use-manage-repository-access.test-helpers';

const mocks = accessMocks();

beforeEach(() => {
  resetAccessMocks();
});

describe('useManageRepositoryAccess supersession', () => {
  it('delivers no return event for an attempt the watchdog already released', async () => {
    vi.useFakeTimers();
    try {
      const firstLaunch = Promise.withResolvers<unknown>();
      const secondLaunch = Promise.withResolvers<unknown>();
      mocks.launch
        .mockReturnValueOnce(firstLaunch.promise)
        .mockReturnValueOnce(secondLaunch.promise);
      const onReturn = vi.fn<(opened: boolean) => void>();
      const resultRef = mountHook('personal', 'github', { onReturn });

      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      await act(() => {
        vi.advanceTimersByTime(20_000);
      });
      // The watchdog released the control, and a second tap superseded the attempt.
      await act(async () => {
        requireHook(resultRef).handlePress();
        await Promise.resolve();
      });
      expect(onReturn).not.toHaveBeenCalled();

      // The superseded attempt settling must not deliver its return edge: the
      // caller's own resync flag belongs to the attempt it is still waiting on.
      await act(async () => {
        firstLaunch.resolve({
          reported: Promise.resolve({ type: 'dismiss' }),
          settledByLaunch: true,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onReturn).not.toHaveBeenCalled();
      expect(requireHook(resultRef).pending).toBe(true);

      // The attempt that owns the control still delivers its own return.
      await act(async () => {
        secondLaunch.resolve({
          reported: Promise.resolve({ type: 'dismiss' }),
          settledByLaunch: true,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onReturn).toHaveBeenCalledTimes(1);
      expect(onReturn).toHaveBeenCalledWith(true);
      expect(requireHook(resultRef).pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
