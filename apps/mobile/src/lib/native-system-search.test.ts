import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SystemSearchDocument } from './native-system-search';

const mocks = vi.hoisted(() => ({ native: null as unknown }));

vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }));

const document: SystemSearchDocument = {
  id: 'session-1',
  title: 'Fix the flaky retry test',
  description: 'An agent session',
  keywords: ['session', 'retry'],
  route: 'kiloapp://agent-chat/session-1',
  fingerprint: 'fp-1',
};

function createNativeModule() {
  const native = {
    addListener: vi.fn(() => ({ remove: vi.fn<() => void>() })),
    applyUpdate: vi.fn<(add: SystemSearchDocument[], removeIds: string[]) => Promise<void>>(),
    indexedFingerprints: vi.fn<() => Promise<Record<string, string>>>(),
    clear: vi.fn<() => Promise<void>>(),
    consumePendingRoute: vi.fn<() => Promise<string | null>>(),
  };
  native.applyUpdate.mockResolvedValue(undefined);
  native.indexedFingerprints.mockResolvedValue({ 'session-1': 'fp-1' });
  native.clear.mockResolvedValue(undefined);
  native.consumePendingRoute.mockResolvedValue('/agent-chat/session-1');
  return native;
}

beforeEach(() => {
  vi.resetModules();
  mocks.native = null;
});

describe('native system search', () => {
  it('reports absence and no-ops every call without throwing', async () => {
    const search = await import('./native-system-search');

    expect(search.isSystemSearchAvailable).toBe(false);
    await expect(search.consumePendingSystemSearchRoute()).resolves.toBeNull();
    expect(search.addSystemSearchOpenListener(vi.fn<() => void>())).toBeNull();
    await expect(search.indexedSystemSearchFingerprints()).resolves.toEqual({});
    await expect(
      search.applySystemSearchUpdate({ add: [document], removeIds: ['session-2'] })
    ).resolves.toBeUndefined();
    await expect(search.clearSystemSearchIndex()).resolves.toBeUndefined();
  });

  it('passes the add and remove payload to the native module unchanged', async () => {
    const native = createNativeModule();
    mocks.native = native;
    const search = await import('./native-system-search');

    expect(search.isSystemSearchAvailable).toBe(true);
    await search.applySystemSearchUpdate({ add: [document], removeIds: ['session-2'] });

    expect(native.applyUpdate).toHaveBeenCalledExactlyOnceWith([document], ['session-2']);
    await expect(search.indexedSystemSearchFingerprints()).resolves.toEqual({
      'session-1': 'fp-1',
    });
    expect(native.indexedFingerprints).toHaveBeenCalledOnce();
    await search.clearSystemSearchIndex();
    expect(native.clear).toHaveBeenCalledOnce();
  });

  it('reads the pending route and forwards the open event', async () => {
    const native = createNativeModule();
    const remove = vi.fn<() => void>();
    native.addListener.mockReturnValue({ remove });
    mocks.native = native;
    const search = await import('./native-system-search');
    const listener = vi.fn<() => void>();

    await expect(search.consumePendingSystemSearchRoute()).resolves.toBe('/agent-chat/session-1');
    expect(native.consumePendingRoute).toHaveBeenCalledOnce();

    const subscription = search.addSystemSearchOpenListener(listener);
    expect(native.addListener).toHaveBeenCalledWith('onSystemSearchOpen', listener);
    subscription?.remove();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('propagates a rejected index update so its caller can retry', async () => {
    const native = createNativeModule();
    native.applyUpdate.mockRejectedValue(new Error('The system search index did not respond.'));
    mocks.native = native;
    const search = await import('./native-system-search');

    await expect(
      search.applySystemSearchUpdate({ add: [document], removeIds: [] })
    ).rejects.toThrow('The system search index did not respond.');
  });
});
