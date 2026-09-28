import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAUNCHER_SURFACES_MODULE_NAME,
  type LauncherSurfacesPayload,
} from './native-launcher-surfaces';

const native = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  setSurfaces: vi.fn(),
  clearDynamicSurfaces: vi.fn(),
  consumePendingLaunchUrl: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: native.requireOptionalNativeModule }));

const payload: LauncherSurfacesPayload = {
  newAgentUrl: 'kilo://new-agent',
  newAgentLabel: 'New agent',
  needsInputUrl: 'kilo://needs-input',
  needsInputLabel: 'Needs input',
  openLastSessionUrl: 'kilo://session/s1',
  openLastSessionLabel: 'Open last session',
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.requireOptionalNativeModule.mockReturnValue(native);
});

describe('native launcher surfaces', () => {
  it('reports absence without throwing during import or on any call', async () => {
    native.requireOptionalNativeModule.mockReturnValue(null);
    const surfaces = await import('./native-launcher-surfaces');
    expect(LAUNCHER_SURFACES_MODULE_NAME).toBe('KiloLauncherSurfaces');
    expect(native.requireOptionalNativeModule).toHaveBeenCalledWith('KiloLauncherSurfaces');
    expect(surfaces.isNativeLauncherSurfacesAvailable).toBe(false);
    expect(() => {
      surfaces.publishLauncherSurfaces(payload);
    }).not.toThrow();
    expect(() => {
      surfaces.clearLauncherSurfaces();
    }).not.toThrow();
    expect(surfaces.consumePendingLaunchUrl()).toBeNull();
    expect(native.setSurfaces).not.toHaveBeenCalled();
    expect(native.clearDynamicSurfaces).not.toHaveBeenCalled();
  });

  it('sends the exact JSON payload the native side parses', async () => {
    const surfaces = await import('./native-launcher-surfaces');
    expect(surfaces.isNativeLauncherSurfacesAvailable).toBe(true);
    surfaces.publishLauncherSurfaces(payload);
    expect(native.setSurfaces).toHaveBeenCalledExactlyOnceWith(
      '{"newAgentUrl":"kilo://new-agent","newAgentLabel":"New agent",' +
        '"needsInputUrl":"kilo://needs-input","needsInputLabel":"Needs input",' +
        '"openLastSessionUrl":"kilo://session/s1","openLastSessionLabel":"Open last session"}'
    );
  });

  it('publishes the nothing-waiting shape with a null Needs input URL', async () => {
    const surfaces = await import('./native-launcher-surfaces');
    surfaces.publishLauncherSurfaces({
      ...payload,
      needsInputUrl: null,
      openLastSessionUrl: null,
    });
    expect(native.setSurfaces).toHaveBeenCalledExactlyOnceWith(
      '{"newAgentUrl":"kilo://new-agent","newAgentLabel":"New agent",' +
        '"needsInputUrl":null,"needsInputLabel":"Needs input",' +
        '"openLastSessionUrl":null,"openLastSessionLabel":"Open last session"}'
    );
  });

  it('clears the dynamic shortcuts on the sign-out path', async () => {
    const surfaces = await import('./native-launcher-surfaces');
    surfaces.clearLauncherSurfaces();
    expect(native.clearDynamicSurfaces).toHaveBeenCalledOnce();
    expect(native.setSurfaces).not.toHaveBeenCalled();
  });

  it('consumes a pending launch URL and reports none otherwise', async () => {
    native.consumePendingLaunchUrl.mockReturnValue('kilo://needs-input');
    const surfaces = await import('./native-launcher-surfaces');
    expect(surfaces.consumePendingLaunchUrl()).toBe('kilo://needs-input');
    native.consumePendingLaunchUrl.mockReturnValue(null);
    expect(surfaces.consumePendingLaunchUrl()).toBeNull();
  });

  it('returns null when the Android module has no pending-launch-url function', async () => {
    native.requireOptionalNativeModule.mockReturnValue({
      setSurfaces: native.setSurfaces,
      clearDynamicSurfaces: native.clearDynamicSurfaces,
    });
    const surfaces = await import('./native-launcher-surfaces');
    expect(surfaces.isNativeLauncherSurfacesAvailable).toBe(true);
    expect(surfaces.consumePendingLaunchUrl()).toBeNull();
  });

  it('never throws into a render or an auth transition when the native side throws', async () => {
    native.setSurfaces.mockImplementation(() => {
      throw new Error('native surface rejected the payload');
    });
    native.clearDynamicSurfaces.mockImplementation(() => {
      throw new Error('native clear failed');
    });
    native.consumePendingLaunchUrl.mockImplementation(() => {
      throw new Error('native read failed');
    });
    const surfaces = await import('./native-launcher-surfaces');
    expect(() => {
      surfaces.publishLauncherSurfaces(payload);
    }).not.toThrow();
    expect(() => {
      surfaces.clearLauncherSurfaces();
    }).not.toThrow();
    expect(surfaces.consumePendingLaunchUrl()).toBeNull();
  });
});
