import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeAppActionHandler } from './native-bridge';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  registerAppActionDispatcher: vi.fn(),
  startAgentNeedsConfirmation: vi.fn(),
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

  it('hands the dispatcher itself over and returns the buffer verbatim', async () => {
    const buffered = [
      { action: 'OpenNeedsInput' },
      '{"action":"open-session","sessionId":"ses_2"}',
      { action: 'NotAnAction' },
      null,
    ];
    native.registerAppActionDispatcher.mockReturnValue(buffered);
    const bridge = await import('./native-bridge');
    const jsHandler = handler();
    const registration = await bridge.registerNativeAppActionDispatcher(jsHandler);
    expect(bridge.isNativeAppActionsAvailable).toBe(true);
    expect(native.registerAppActionDispatcher).toHaveBeenCalledExactlyOnceWith(jsHandler);
    // The handler stays the dispatcher's own: nothing wraps it, and its result
    // is the app's, not a value the native module reads back.
    expect(registration.handle).toBe(jsHandler);
    // Verbatim: decoding each payload into the contract is the dispatcher's
    // replay, not the bridge's.
    expect(registration.buffered).toEqual(buffered);
  });

  it('accepts a single buffered payload that is not wrapped in an array', async () => {
    native.registerAppActionDispatcher.mockReturnValue({
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
    native.registerAppActionDispatcher.mockReturnValue(undefined);
    const bridge = await import('./native-bridge');
    const { buffered } = await bridge.registerNativeAppActionDispatcher(handler());
    expect(buffered).toEqual([]);
  });

  it('takes the confirmation requirement from the platform that declares one', async () => {
    native.startAgentNeedsConfirmation.mockReturnValue(true);
    const bridge = await import('./native-bridge');
    expect(bridge.startAgentNeedsConfirmation()).toBe(true);
  });

  it('asks nothing on a platform that runs its intents without a screen', async () => {
    // iOS registers a dispatcher and declares no confirmation: its App Intent
    // hands the request over with the app closed, where no dialog can appear.
    native.requireOptionalNativeModule.mockReturnValue({
      registerAppActionDispatcher: native.registerAppActionDispatcher,
    });
    const bridge = await import('./native-bridge');
    expect(bridge.startAgentNeedsConfirmation()).toBe(false);
  });

  it('asks nothing when the binary has no app-action surface at all', async () => {
    native.requireOptionalNativeModule.mockReturnValue(null);
    const bridge = await import('./native-bridge');
    expect(bridge.startAgentNeedsConfirmation()).toBe(false);
  });

  it('keeps the dispatch result on a platform whose entry points read the promise', async () => {
    native.registerAppActionDispatcher.mockReturnValue([]);
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await expect(handle({ action: 'OpenNeedsInput' })).resolves.toEqual(HANDLER_RESULT);
  });
});
