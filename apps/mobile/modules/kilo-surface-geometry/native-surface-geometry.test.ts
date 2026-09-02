import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NativeSurfaceGeometry } from '../../src/lib/native-surface-geometry';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  addListener:
    vi.fn<
      (event: string, listener: (geometry: NativeSurfaceGeometry) => void) => { remove: () => void }
    >(),
  observeSurface: vi.fn(),
  unobserveSurface: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

const initial: NativeSurfaceGeometry = {
  tag: 42,
  visibleTop: 0,
  visibleBottom: 400,
  boundsHeight: 600,
  safeAreaTop: 20,
  safeAreaBottom: 20,
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.requireOptionalNativeModule.mockReturnValue(native);
  native.observeSurface.mockResolvedValue(initial);
});

describe('native surface geometry', () => {
  it('reports absence without inventing geometry or throwing during import', async () => {
    native.requireOptionalNativeModule.mockReturnValue(null);
    const surface = await import('../../src/lib/native-surface-geometry');
    expect(native.requireOptionalNativeModule).toHaveBeenCalledWith('KiloSurfaceGeometry');
    expect(surface.isNativeSurfaceGeometryAvailable).toBe(false);
    expect(surface.addSurfaceGeometryListener(vi.fn<() => void>())).toBeNull();
    await expect(surface.observeSurface(42)).rejects.toThrow('requires a rebuilt');
    await expect(surface.unobserveSurface(42)).resolves.toBeUndefined();
  });

  it('returns the initial snapshot and exposes event and native cleanup', async () => {
    const remove = vi.fn<() => void>();
    native.addListener.mockReturnValue({ remove });
    const surface = await import('../../src/lib/native-surface-geometry');
    const listener = vi.fn<(geometry: NativeSurfaceGeometry) => void>();
    const subscription = surface.addSurfaceGeometryListener(listener);
    expect(surface.isNativeSurfaceGeometryAvailable).toBe(true);
    expect(native.addListener).toHaveBeenCalledWith('onSurfaceGeometryChange', listener);
    await expect(surface.observeSurface(42)).resolves.toEqual(initial);
    expect(native.observeSurface).toHaveBeenCalledWith(42);
    native.addListener.mock.calls[0]?.[1](initial);
    expect(listener).toHaveBeenCalledExactlyOnceWith(initial);
    subscription?.remove();
    await surface.unobserveSurface(42);
    expect(remove).toHaveBeenCalledOnce();
    expect(native.unobserveSurface).toHaveBeenCalledWith(42);
  });

  it('accepts the largest positive signed 32-bit native tag', async () => {
    const surface = await import('../../src/lib/native-surface-geometry');
    await surface.observeSurface(2_147_483_647);
    expect(native.observeSurface).toHaveBeenCalledWith(2_147_483_647);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid native tag %s before crossing the native boundary',
    async tag => {
      const surface = await import('../../src/lib/native-surface-geometry');
      await expect(surface.observeSurface(tag)).rejects.toThrow(RangeError);
      expect(native.observeSurface).not.toHaveBeenCalled();
    }
  );

  it('preserves native errors instead of substituting a JS measurement', async () => {
    native.observeSurface.mockRejectedValue(new Error('The native surface view is not mounted.'));
    const surface = await import('../../src/lib/native-surface-geometry');
    await expect(surface.observeSurface(42)).rejects.toThrow('not mounted');
  });
});
