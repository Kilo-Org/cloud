import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from '@jest/globals';

import { DeviceAuthClient } from './DeviceAuthClient';
import {
  buildDeviceAuthVerificationUrl,
  closeDeviceAuthWindowIfAppMode,
  getDeviceAuthAppModeFromRequestUrl,
  getDeviceAuthSignInUrl,
  getDeviceAuthShellClassName,
} from './device-auth-url';

// @swc/jest compiles JSX with the classic runtime, and the component imports no
// React default, so its `React.createElement` calls need React on the global.
Object.assign(globalThis, { React });

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

  test('uses the dynamic viewport minimum height to center app-mode authorization content', () => {
    const tokens = getDeviceAuthShellClassName(true).split(' ');
    expect(tokens).toContain('min-h-dvh');
    expect(tokens).not.toContain('h-dvh');
    expect(tokens).toContain('w-full');
    expect(tokens).toContain('items-center');
    expect(tokens).toContain('justify-center');
    expect(tokens).toContain('max-[22rem]:px-2');
  });
});

describe('DeviceAuthClient layout', () => {
  const renderClient = (user: { name: string; email: string; imageUrl: string }) =>
    renderToStaticMarkup(
      React.createElement(DeviceAuthClient, {
        code: 'ABC-123',
        viewerToken: 'v',
        isAppMode: true,
        user,
      })
    );

  test('reflows the identity row so the account identity stays visible at narrow width', () => {
    const html = renderClient({ name: 'Test User', email: 'test@example.com', imageUrl: '' });

    expect(html).toContain('min-h-dvh');
    expect(html).toContain('max-[22rem]:flex-col');
    expect(html).toContain('max-[22rem]:items-stretch');
    expect(html).toContain('class="min-w-0 flex-1"');
    expect(html).toContain('shrink-0');
    expect(html).toContain('max-[22rem]:w-full');
    expect(html).toContain('space-y-4 max-[22rem]:px-2');
    expect(html).toContain('p-3 max-[22rem]:flex-col max-[22rem]:items-stretch max-[22rem]:p-2');
    expect(html).toContain(
      'class="flex min-w-0 flex-1 items-center gap-3 max-[22rem]:flex-col max-[22rem]:items-stretch"'
    );
    expect(html).toContain('class="space-y-2 rounded-lg border p-4 max-[22rem]:p-2"');
    expect(html).toContain('class="flex gap-3 max-[22rem]:flex-col"');
    expect(html).toContain('flex-1 max-[22rem]:w-full max-[22rem]:px-2');
    expect(html).toContain('Signed in as');
    expect(html).toContain('Test User');
    expect(html).toContain('test@example.com');
  });

  test('shows the email once as the account name when the viewer has no display name', () => {
    const html = renderClient({ name: '', email: 'test@example.com', imageUrl: '' });

    expect(html.split('test@example.com')).toHaveLength(2);
  });

  test('lets the verification code wrap so it stays inside the card border at narrow width', () => {
    const html = renderClient({ name: 'Test User', email: 'test@example.com', imageUrl: '' });

    expect(html).toContain('class="text-2xl font-bold tracking-wider break-all"');
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
