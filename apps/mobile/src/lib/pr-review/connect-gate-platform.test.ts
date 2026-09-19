import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getConnectGatePlatformPlan,
  launchConnectGateBrowser,
  openAuthorizationAndWaitForReturn,
} from './connect-gate-platform';

const webBrowserMocks = vi.hoisted(() => ({
  openAuthSessionAsync: vi.fn<(url: string) => Promise<unknown>>(),
  openBrowserAsync: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: webBrowserMocks.openAuthSessionAsync,
  openBrowserAsync: webBrowserMocks.openBrowserAsync,
}));

beforeEach(() => {
  webBrowserMocks.openAuthSessionAsync.mockReset();
  webBrowserMocks.openBrowserAsync.mockReset();
});

describe('getConnectGatePlatformPlan', () => {
  it('uses the native auth session and refetches on sheet close for iOS', () => {
    expect(getConnectGatePlatformPlan('ios')).toEqual({
      launcher: 'openAuthSession',
      refetchTrigger: 'sheet-close',
    });
  });

  it('uses a plain custom-tab browser and refetches on app-foreground for Android', () => {
    expect(getConnectGatePlatformPlan('android')).toEqual({
      launcher: 'openBrowser',
      refetchTrigger: 'app-foreground',
    });
  });

  it('falls back to the Android plan for unknown platforms (web, etc.)', () => {
    expect(getConnectGatePlatformPlan('web')).toEqual({
      launcher: 'openBrowser',
      refetchTrigger: 'app-foreground',
    });
    expect(getConnectGatePlatformPlan('')).toEqual({
      launcher: 'openBrowser',
      refetchTrigger: 'app-foreground',
    });
  });
});

describe('openAuthorizationAndWaitForReturn', () => {
  it('uses openAuthSessionAsync on iOS and reports sheet-close', async () => {
    webBrowserMocks.openAuthSessionAsync.mockResolvedValue('done');
    const trigger = await openAuthorizationAndWaitForReturn('ios', 'https://example.com/connect');
    expect(webBrowserMocks.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://example.com/connect'
    );
    expect(webBrowserMocks.openBrowserAsync).not.toHaveBeenCalled();
    expect(trigger).toBe('sheet-close');
  });

  it('uses openBrowserAsync on Android and reports app-foreground', async () => {
    webBrowserMocks.openBrowserAsync.mockResolvedValue(undefined);
    const trigger = await openAuthorizationAndWaitForReturn(
      'android',
      'https://example.com/connect'
    );
    expect(webBrowserMocks.openBrowserAsync).toHaveBeenCalledWith('https://example.com/connect');
    expect(webBrowserMocks.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(trigger).toBe('app-foreground');
  });
});

describe('launchConnectGateBrowser', () => {
  it('arms the sentinel, clears it, and refetches on an iOS sheet-close', async () => {
    webBrowserMocks.openAuthSessionAsync.mockResolvedValue('done');
    const handlers = {
      markLaunched: vi.fn(),
      clearLaunch: vi.fn(),
      onSheetClose: vi.fn().mockResolvedValue(undefined),
      onOpenFailure: vi.fn(),
    };

    await launchConnectGateBrowser('ios', 'https://example.com/connect', handlers);

    expect(handlers.markLaunched).toHaveBeenCalledOnce();
    expect(handlers.clearLaunch).toHaveBeenCalledOnce();
    expect(handlers.onSheetClose).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });

  it('leaves the sentinel armed for the Android foreground return', async () => {
    webBrowserMocks.openBrowserAsync.mockResolvedValue(undefined);
    const handlers = {
      markLaunched: vi.fn(),
      clearLaunch: vi.fn(),
      onSheetClose: vi.fn().mockResolvedValue(undefined),
      onOpenFailure: vi.fn(),
    };

    await launchConnectGateBrowser('android', 'https://example.com/connect', handlers);

    expect(handlers.markLaunched).toHaveBeenCalledOnce();
    expect(handlers.clearLaunch).not.toHaveBeenCalled();
    expect(handlers.onSheetClose).not.toHaveBeenCalled();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });

  it('reports an unopenable browser instead of leaving the CTA inert', async () => {
    webBrowserMocks.openAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    const handlers = {
      markLaunched: vi.fn(),
      clearLaunch: vi.fn(),
      onSheetClose: vi.fn().mockResolvedValue(undefined),
      onOpenFailure: vi.fn(),
    };

    await expect(
      launchConnectGateBrowser('ios', 'https://example.com/connect', handlers)
    ).resolves.toBeUndefined();

    expect(handlers.markLaunched).toHaveBeenCalledOnce();
    expect(handlers.clearLaunch).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).toHaveBeenCalledOnce();
    expect(handlers.onSheetClose).not.toHaveBeenCalled();
  });
});
