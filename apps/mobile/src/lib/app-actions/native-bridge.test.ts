import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeAppActionHandler } from './native-bridge';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  registerAppActionDispatcher: vi.fn(),
  completeAppAction: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

function handler(): NativeAppActionHandler {
  return async () => {
    await Promise.resolve();
    return { ok: true, action: 'OpenNeedsInput', message: '' };
  };
}

const HANDLER_RESULT = { ok: true, action: 'OpenNeedsInput', message: '' };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.requireOptionalNativeModule.mockReturnValue(native);
});

describe('native app actions bridge', () => {
  it('reports absence without throwing at import and registers nothing', async () => {
    native.requireOptionalNativeModule.mockReturnValue(null);
    const bridge = await import('./native-bridge');
    expect(native.requireOptionalNativeModule).toHaveBeenCalledWith('KiloAppActions');
    expect(bridge.isNativeAppActionsAvailable).toBe(false);
    const registration = await bridge.registerNativeAppActionDispatcher(handler());
    expect(registration.buffered).toEqual([]);
    await expect(registration.handle({ action: 'OpenNeedsInput' })).resolves.toEqual(
      HANDLER_RESULT
    );
    expect(native.registerAppActionDispatcher).not.toHaveBeenCalled();
  });

  it('hands the wrapped handler over and returns the buffer verbatim', async () => {
    const buffered = [
      { action: 'OpenNeedsInput' },
      '{"action":"open-session","sessionId":"ses_2"}',
      { action: 'NotAnAction' },
      null,
    ];
    native.registerAppActionDispatcher.mockResolvedValue(buffered);
    const bridge = await import('./native-bridge');
    const jsHandler = handler();
    const registration = await bridge.registerNativeAppActionDispatcher(jsHandler);
    expect(bridge.isNativeAppActionsAvailable).toBe(true);
    expect(native.registerAppActionDispatcher).toHaveBeenCalledExactlyOnceWith(registration.handle);
    expect(registration.handle).not.toBe(jsHandler);
    // Verbatim: decoding each payload into the contract is the dispatcher's
    // replay, not the bridge's.
    expect(registration.buffered).toEqual(buffered);
  });

  it('accepts a single buffered payload that is not wrapped in an array', async () => {
    native.registerAppActionDispatcher.mockResolvedValue({
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    });
    const bridge = await import('./native-bridge');
    const { buffered } = await bridge.registerNativeAppActionDispatcher(handler());
    expect(buffered).toEqual([
      { action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' },
    ]);
  });

  it('treats an empty buffer as nothing to replay', async () => {
    native.registerAppActionDispatcher.mockResolvedValue(undefined);
    const bridge = await import('./native-bridge');
    const { buffered } = await bridge.registerNativeAppActionDispatcher(handler());
    expect(buffered).toEqual([]);
  });

  it('reports a settled result to the waiting entry point through completeAppAction', async () => {
    native.registerAppActionDispatcher.mockResolvedValue([]);
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await handle('{"action":"open-needs-input"}');
    expect(native.completeAppAction).toHaveBeenCalledExactlyOnceWith(
      '{"action":"open-needs-input"}',
      JSON.stringify(HANDLER_RESULT)
    );
  });

  it('reports a non-text payload as its canonical JSON text', async () => {
    native.registerAppActionDispatcher.mockResolvedValue([]);
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await handle({ action: 'OpenNeedsInput' });
    expect(native.completeAppAction).toHaveBeenCalledExactlyOnceWith(
      '{"action":"OpenNeedsInput"}',
      JSON.stringify(HANDLER_RESULT)
    );
  });

  it('keeps the dispatch result on a platform whose entry points read the promise', async () => {
    // iOS registers a dispatcher but has no completeAppAction function.
    native.requireOptionalNativeModule.mockReturnValue({
      registerAppActionDispatcher: native.registerAppActionDispatcher,
    });
    native.registerAppActionDispatcher.mockResolvedValue([]);
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await expect(handle({ action: 'OpenNeedsInput' })).resolves.toEqual(HANDLER_RESULT);
  });

  it('keeps the dispatch result when reporting the completion throws', async () => {
    native.registerAppActionDispatcher.mockResolvedValue([]);
    native.completeAppAction.mockImplementation(() => {
      throw new Error('bridge gone');
    });
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await expect(handle({ action: 'OpenNeedsInput' })).resolves.toEqual(HANDLER_RESULT);
  });
});
