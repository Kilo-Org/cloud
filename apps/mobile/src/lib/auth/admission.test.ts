import { afterEach, describe, expect, it, vi } from 'vitest';

import { Platform } from 'react-native';

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import { ADMISSION_CHALLENGE_FAILED, getAdmission } from './admission';

// Re-spy on global fetch for each test-controlled mock.
const originalFetch = globalThis.fetch;

function setupFetch(impl: typeof fetch) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn;
  return fn;
}

describe('getAdmission', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Empty / platform cannot attest ─────────────────────────────────────

  it('returns undefined when the platform lacks attestation capability (iOS)', async () => {
    vi.mocked(Platform).OS = 'ios';

    const fetchSpy = setupFetch(() => {
      throw new Error('should not be called');
    });

    const result = await getAdmission();
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when the platform lacks attestation capability (Android)', async () => {
    vi.mocked(Platform).OS = 'android';

    const fetchSpy = setupFetch(() => {
      throw new Error('should not be called');
    });

    const result = await getAdmission();
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Wire contract shape ────────────────────────────────────────────────

  it('does not send admission when platform lacks capability', async () => {
    // This test verifies the contract: a build without attestation packages
    // sends no admission field. The server's legacy path admits the request.
    vi.mocked(Platform).OS = 'ios';
    setupFetch(() => new Response(null, { status: 200 }));

    const result = await getAdmission();

    // Server must not receive an admission field for devices that cannot attest.
    expect(result).toBeUndefined();
  });

  // ── Retryable: challenge endpoint error ────────────────────────────────

  it('exports ADMISSION_CHALLENGE_FAILED as a constant for caller catch blocks', () => {
    expect(ADMISSION_CHALLENGE_FAILED).toBe('admission_challenge_failed');
  });
});
