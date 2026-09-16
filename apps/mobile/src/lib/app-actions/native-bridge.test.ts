import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeAppActionHandler } from './native-bridge';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  registerAppActionDispatcher: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

function handler(): NativeAppActionHandler {
  return async () => {
    await Promise.resolve();
    return { ok: true, action: 'OpenNeedsInput', message: '' };
  };
}

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
    await expect(bridge.registerNativeAppActionDispatcher(handler())).resolves.toEqual([]);
    expect(native.registerAppActionDispatcher).not.toHaveBeenCalled();
  });

  it('hands the handler over and parses the buffered payloads in arrival order', async () => {
    native.registerAppActionDispatcher.mockResolvedValue([
      { action: 'OpenNeedsInput' },
      '{"action":"open-session","sessionId":"ses_2"}',
      { action: 'NotAnAction' },
      null,
    ]);
    const bridge = await import('./native-bridge');
    const jsHandler = handler();
    const buffered = await bridge.registerNativeAppActionDispatcher(jsHandler);
    expect(bridge.isNativeAppActionsAvailable).toBe(true);
    expect(native.registerAppActionDispatcher).toHaveBeenCalledWith(jsHandler);
    expect(buffered).toEqual([
      { action: 'OpenNeedsInput' },
      { action: 'OpenSession', sessionId: 'ses_2' },
    ]);
  });

  it('accepts a single buffered payload that is not wrapped in an array', async () => {
    native.registerAppActionDispatcher.mockResolvedValue({
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    });
    const bridge = await import('./native-bridge');
    await expect(bridge.registerNativeAppActionDispatcher(handler())).resolves.toEqual([
      { action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' },
    ]);
  });

  it('treats an empty buffer as nothing to replay', async () => {
    native.registerAppActionDispatcher.mockResolvedValue(undefined);
    const bridge = await import('./native-bridge');
    await expect(bridge.registerNativeAppActionDispatcher(handler())).resolves.toEqual([]);
  });
});
