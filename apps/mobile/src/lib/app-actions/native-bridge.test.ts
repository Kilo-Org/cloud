import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeAppActionHandler } from './native-bridge';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  registerAppActionDispatcher: vi.fn(),
  replaceSessionCatalog: vi.fn(),
  clearSessionCatalog: vi.fn(),
  setSessionCatalogLock: vi.fn(),
  setSessionCatalogVisible: vi.fn(),
  setVisibleSession: vi.fn(),
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

  it('keeps the dispatch result on a platform whose entry points read the promise', async () => {
    native.registerAppActionDispatcher.mockReturnValue([]);
    const bridge = await import('./native-bridge');
    const { handle } = await bridge.registerNativeAppActionDispatcher(handler());
    await expect(handle({ action: 'OpenNeedsInput' })).resolves.toEqual(HANDLER_RESULT);
  });
});

describe('the session catalog bridge', () => {
  it('reports absence on a binary built before the catalog shipped', async () => {
    const legacy = {
      requireOptionalNativeModule: native.requireOptionalNativeModule,
      registerAppActionDispatcher: native.registerAppActionDispatcher,
    };
    native.requireOptionalNativeModule.mockReturnValue(legacy);
    const bridge = await import('./native-bridge');

    expect(bridge.isNativeAppActionsAvailable).toBe(true);
    await expect(
      bridge.replaceNativeSessionCatalog([{ id: 'sess-1', title: 'Fix' }])
    ).resolves.toBe(false);
    await expect(bridge.clearNativeSessionCatalog()).resolves.toBe(false);
    // The two lock calls are absent on that binary, so the pushes are no-ops
    // rather than throws.
    bridge.setNativeSessionCatalogLock(true, 300_000);
    bridge.setNativeSessionCatalogVisible(true);
    await expect(bridge.setNativeVisibleSession('sess-1')).resolves.toBeUndefined();
  });

  it('publishes the whole list, and reports only a real change as changed', async () => {
    const bridge = await import('./native-bridge');

    native.replaceSessionCatalog.mockResolvedValueOnce(true);
    await expect(
      bridge.replaceNativeSessionCatalog([
        { id: 'sess-1', title: 'Fix login bug' },
        { id: 'sess-2', title: 'Deploy review' },
      ])
    ).resolves.toBe(true);
    expect(native.replaceSessionCatalog).toHaveBeenCalledExactlyOnceWith([
      { id: 'sess-1', title: 'Fix login bug' },
      { id: 'sess-2', title: 'Deploy review' },
    ]);

    // The device says "same bytes": the sync reports no change for it.
    native.replaceSessionCatalog.mockResolvedValueOnce(false);
    await expect(
      bridge.replaceNativeSessionCatalog([{ id: 'sess-1', title: 'Fix login bug' }])
    ).resolves.toBe(false);
  });

  it('sends only the two fields the native record reads', async () => {
    const bridge = await import('./native-bridge');
    native.replaceSessionCatalog.mockResolvedValueOnce(true);
    // A caller's extra fields must not reach the native record.
    const entry: { id: string; title: string; route: string } = {
      id: 'sess-1',
      title: 'Fix login bug',
      route: '/(app)/agent-chat/sess-1',
    };

    await bridge.replaceNativeSessionCatalog([entry]);

    expect(native.replaceSessionCatalog).toHaveBeenCalledExactlyOnceWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
  });

  it('clears the catalog and reports whether anything was wiped', async () => {
    const bridge = await import('./native-bridge');

    native.clearSessionCatalog.mockResolvedValueOnce(false);
    await expect(bridge.clearNativeSessionCatalog()).resolves.toBe(false);

    native.clearSessionCatalog.mockResolvedValueOnce(true);
    await expect(bridge.clearNativeSessionCatalog()).resolves.toBe(true);
  });

  it('hands the lock switch and its interval over in one call', async () => {
    const bridge = await import('./native-bridge');

    bridge.setNativeSessionCatalogLock(true, 300_000);

    // One call, so the store can never hold one half of the pair: the switch
    // alone would withhold an unlocked device's titles, the interval alone
    // would withhold nothing.
    expect(native.setSessionCatalogLock).toHaveBeenCalledExactlyOnceWith(true, 300_000);
  });

  it('hands the launch’s visibility over on every edge', async () => {
    const bridge = await import('./native-bridge');

    bridge.setNativeSessionCatalogVisible(false);
    bridge.setNativeSessionCatalogVisible(true);

    // Both answers reach the store in the order the lock produced them: the
    // store starts closed, so a dropped `true` would hide an unlocked app's
    // titles and a dropped `false` would expose a locked one's.
    expect(native.setSessionCatalogVisible.mock.calls).toEqual([[false], [true]]);
  });

  it('publishes the visible session in the order the screen produced it', async () => {
    const bridge = await import('./native-bridge');
    const order: (string | null)[] = [];
    const gate = Promise.withResolvers<undefined>();
    native.setVisibleSession.mockImplementationOnce(async (sessionId: string | null) => {
      // Hold the first publish so a naive pass-through would let the second
      // land first.
      await gate.promise;
      order.push(sessionId);
    });
    native.setVisibleSession.mockImplementation((sessionId: string | null) => {
      order.push(sessionId);
      return Promise.resolve();
    });

    const first = bridge.setNativeVisibleSession('sess-1');
    const second = bridge.setNativeVisibleSession('sess-2');
    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(order).toEqual(['sess-1', 'sess-2']);
    native.setVisibleSession.mockClear();
    await bridge.setNativeVisibleSession(null);
    expect(native.setVisibleSession).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('keeps the chain alive after a failed publish', async () => {
    const bridge = await import('./native-bridge');
    native.setVisibleSession.mockRejectedValueOnce(new Error('no key window'));

    await expect(bridge.setNativeVisibleSession('sess-1')).rejects.toThrow('no key window');
    // The rejection is the caller's to report; the next publish still runs.
    await expect(bridge.setNativeVisibleSession('sess-2')).resolves.toBeUndefined();
    expect(native.setVisibleSession).toHaveBeenLastCalledWith('sess-2');
  });
});
