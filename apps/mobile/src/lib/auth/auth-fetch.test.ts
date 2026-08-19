import { afterEach, describe, expect, it, vi } from 'vitest';

import { postAuth } from '@/lib/auth/auth-fetch';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

// The admission module imports expo-secure-store, expo-crypto, and
// @expo/app-integrity, which need a device runtime. Stub the single export
// postAuth uses.
vi.mock('@/lib/auth/admission', () => ({
  clearAttestKeyOnRefusal: vi.fn(),
}));

describe('postAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards ssoOrganizationId on a non-ok SSO_ERROR response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'SSO_ERROR', ssoOrganizationId: 'org_1' }, { status: 400 })
    );

    const result = await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'SSO_ERROR',
      ssoOrganizationId: 'org_1',
    });
  });

  it('resolves ssoOrganizationId undefined when the field is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'BLOCKED' }, { status: 400 })
    );

    const result = await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'BLOCKED',
      ssoOrganizationId: undefined,
    });
  });
});
