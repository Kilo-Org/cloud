import { describe, expect, test } from '@jest/globals';

import {
  buildDeviceAuthVerificationUrl,
  closeDeviceAuthWindowIfAppMode,
  getDeviceAuthAppModeFromRequestUrl,
  getDeviceAuthSignInUrl,
  getDeviceAuthShellClassName,
} from './device-auth-url';

describe('getDeviceAuthSignInUrl', () => {
  test('preserves the device auth code through sign in', () => {
    expect(getDeviceAuthSignInUrl('ABC-123')).toBe(
      '/users/sign_in?callbackPath=%2Fdevice-auth%3Fcode%3DABC-123'
    );
  });

  test('encodes code characters inside the callback path', () => {
    expect(getDeviceAuthSignInUrl('abc 123')).toBe(
      '/users/sign_in?callbackPath=%2Fdevice-auth%3Fcode%3Dabc%2B123'
    );
  });

  test('preserves app mode through sign in', () => {
    expect(getDeviceAuthSignInUrl('ABC-123', { app: true })).toBe(
      '/users/sign_in?callbackPath=%2Fdevice-auth%3Fcode%3DABC-123%26app%3D1'
    );
  });
});

describe('buildDeviceAuthVerificationUrl', () => {
  test('omits app mode by default for non-app callers', () => {
    expect(buildDeviceAuthVerificationUrl('https://app.kilo.ai', 'ABC-123')).toBe(
      'https://app.kilo.ai/device-auth?code=ABC-123'
    );
  });

  test('adds the app mode query parameter for mobile browser launches', () => {
    expect(buildDeviceAuthVerificationUrl('https://app.kilo.ai', 'ABC-123', { app: true })).toBe(
      'https://app.kilo.ai/device-auth?code=ABC-123&app=1'
    );
  });
});

describe('getDeviceAuthAppModeFromRequestUrl', () => {
  test('derives app mode from the API request URL', () => {
    expect(
      getDeviceAuthAppModeFromRequestUrl('https://app.kilo.ai/api/device-auth/codes?app=1')
    ).toBe(true);
  });

  test('leaves app mode off unless explicitly requested', () => {
    expect(getDeviceAuthAppModeFromRequestUrl('https://app.kilo.ai/api/device-auth/codes')).toBe(
      false
    );
  });
});

describe('getDeviceAuthShellClassName', () => {
  test('uses page padding by default', () => {
    expect(getDeviceAuthShellClassName(false)).toContain('p-4');
  });

  test('removes top and bottom page padding in app mode', () => {
    expect(getDeviceAuthShellClassName(true)).not.toContain('p-4');
    expect(getDeviceAuthShellClassName(true)).toContain('py-0');
    expect(getDeviceAuthShellClassName(true)).toContain('px-4');
  });

  test('uses the dynamic viewport height to center app-mode authorization content', () => {
    expect(getDeviceAuthShellClassName(true)).toContain('h-dvh');
    expect(getDeviceAuthShellClassName(true)).toContain('w-full');
    expect(getDeviceAuthShellClassName(true)).toContain('items-center');
    expect(getDeviceAuthShellClassName(true)).toContain('justify-center');
  });
});

describe('closeDeviceAuthWindowIfAppMode', () => {
  test('attempts to close the window in app mode', () => {
    let closeCount = 0;

    closeDeviceAuthWindowIfAppMode(true, () => {
      closeCount++;
    });

    expect(closeCount).toBe(1);
  });

  test('does not close the window outside app mode', () => {
    let closeCount = 0;

    closeDeviceAuthWindowIfAppMode(false, () => {
      closeCount++;
    });

    expect(closeCount).toBe(0);
  });
});
