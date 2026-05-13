import { describe, expect, test } from '@jest/globals';

import { getDeviceAuthSignInUrl } from './DeviceAuthClient';

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
});
