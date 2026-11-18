import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

describe('artifact provider native bridge', () => {
  it('reads ArtifactsProvider and no-ops when the module is absent', async () => {
    native.requireOptionalNativeModule.mockReturnValue(null);
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    expect(native.requireOptionalNativeModule).toHaveBeenCalledWith('ArtifactsProvider');
    expect(() => {
      bridge.notifyArtifactsChanged();
    }).not.toThrow();
    // Without the module (JS-only build) the call still hands back a promise,
    // one that resolves, so callers can await the registration uniformly.
    await expect(bridge.registerArtifactsProviderDomain()).resolves.toBeUndefined();
  });

  it('delegates to the module and tolerates a platform without the iOS domain entry point', async () => {
    const notifyArtifactsChanged = vi.fn<() => void>();
    native.requireOptionalNativeModule.mockReturnValue({ notifyArtifactsChanged });
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    bridge.notifyArtifactsChanged();

    expect(notifyArtifactsChanged).toHaveBeenCalledOnce();
    // The Android module ships no domain entry point: registering must no-op.
    await expect(bridge.registerArtifactsProviderDomain()).resolves.toBeUndefined();
  });

  it('registers the iOS File Provider domain when the module provides it', async () => {
    const registerArtifactsProviderDomain = vi.fn<() => Promise<void>>();
    native.requireOptionalNativeModule.mockReturnValue({
      notifyArtifactsChanged: vi.fn<() => void>(),
      registerArtifactsProviderDomain,
    });
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    await bridge.registerArtifactsProviderDomain();

    expect(registerArtifactsProviderDomain).toHaveBeenCalledOnce();
  });

  it('propagates a native registration rejection to the caller', async () => {
    const failure = new Error('no file provider domain');
    native.requireOptionalNativeModule.mockReturnValue({
      notifyArtifactsChanged: vi.fn<() => void>(),
      registerArtifactsProviderDomain: vi.fn<() => Promise<void>>().mockRejectedValue(failure),
    });
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    // The bridge adds no absorption on iOS: the mount decides what a failed
    // registration means, so the rejection surfaces here.
    await expect(bridge.registerArtifactsProviderDomain()).rejects.toBe(failure);
  });
});
