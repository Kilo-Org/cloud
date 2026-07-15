import { describe, expect, it, vi } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  createVoiceInputNativeHarness,
  deferredPermission,
  makeStartOptions,
} from './voice-input-controller-test-helpers';

describe('createVoiceInputController - pending start', () => {
  it('cancels a pending owner start before permission resolves', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const permission = deferredPermission();
    harness.mocks.getPermissions.mockImplementationOnce(async () => {
      const result = await permission.promise;
      return result;
    });

    const startPromise = controller.start(makeStartOptions({ owner: 'A' }));
    await vi.waitFor(() => {
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
    });

    await expect(controller.abort('A')).resolves.toBe(true);
    permission.resolve({ granted: true, canAskAgain: true });

    await expect(startPromise).resolves.toBe(false);
    expect(harness.mocks.start).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ owner: null, status: 'idle' });
  });

  it('cancels a pending owner start when stop is requested before permission resolves', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const permission = deferredPermission();
    harness.mocks.getPermissions.mockImplementationOnce(async () => {
      const result = await permission.promise;
      return result;
    });

    const startPromise = controller.start(makeStartOptions({ owner: 'A' }));
    await vi.waitFor(() => {
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
    });

    await expect(controller.stop('A')).resolves.toBe(true);
    permission.resolve({ granted: true, canAskAgain: true });

    await expect(startPromise).resolves.toBe(false);
    expect(harness.mocks.start).not.toHaveBeenCalled();
  });

  it('serializes pending starts and only starts recognition for the latest owner', async () => {
    const harness = createVoiceInputNativeHarness();
    const controller = createVoiceInputController(harness.native);
    const firstPermission = deferredPermission();
    harness.mocks.getPermissions
      .mockImplementationOnce(async () => {
        const result = await firstPermission.promise;
        return result;
      })
      .mockResolvedValueOnce({ granted: true, canAskAgain: true });

    const firstStart = controller.start(makeStartOptions({ owner: 'A' }));
    await vi.waitFor(() => {
      expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
    });
    const secondStart = controller.start(makeStartOptions({ owner: 'B' }));

    expect(harness.mocks.getPermissions).toHaveBeenCalledTimes(1);
    firstPermission.resolve({ granted: true, canAskAgain: true });

    await expect(firstStart).resolves.toBe(false);
    await expect(secondStart).resolves.toBe(true);
    expect(harness.mocks.start).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ owner: 'B', status: 'starting' });
  });
});
