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
    expect(() => {
      bridge.registerArtifactsProviderDomain();
    }).not.toThrow();
  });

  it('delegates to the module and tolerates a platform without the iOS domain entry point', async () => {
    const notifyArtifactsChanged = vi.fn<() => void>();
    native.requireOptionalNativeModule.mockReturnValue({ notifyArtifactsChanged });
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    bridge.notifyArtifactsChanged();

    expect(notifyArtifactsChanged).toHaveBeenCalledOnce();
    // The Android module ships no domain entry point: registering must no-op.
    expect(() => {
      bridge.registerArtifactsProviderDomain();
    }).not.toThrow();
  });

  it('registers the iOS File Provider domain when the module provides it', async () => {
    const registerArtifactsProviderDomain = vi.fn<() => void>();
    native.requireOptionalNativeModule.mockReturnValue({
      notifyArtifactsChanged: vi.fn<() => void>(),
      registerArtifactsProviderDomain,
    });
    const bridge = await import('@/lib/artifacts/artifact-provider-native');

    bridge.registerArtifactsProviderDomain();

    expect(registerArtifactsProviderDomain).toHaveBeenCalledOnce();
  });
});
