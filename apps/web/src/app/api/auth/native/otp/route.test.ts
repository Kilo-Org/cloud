import { createSignInCode, deleteSignInCode } from '@/lib/auth/magic-link-tokens';
import { sendSignInCodeEmail } from '@/lib/email';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/email');
jest.mock('@/lib/auth/email-signin-eligibility');

import { POST } from './route';

const mockCreateSignInCode = jest.mocked(createSignInCode);
const mockDeleteSignInCode = jest.mocked(deleteSignInCode);
const mockSendSignInCodeEmail = jest.mocked(sendSignInCodeEmail);
const mockCheckEmailSignInEligibility = jest.mocked(checkEmailSignInEligibility);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('POST /api/auth/native/otp', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/native/otp', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  const createMalformedRequest = () =>
    new NextRequest('http://localhost:3000/api/auth/native/otp', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    jest.clearAllMocks();

    mockCheckEmailSignInEligibility.mockResolvedValue({ ok: true });
    mockCreateSignInCode.mockResolvedValue({
      code: '123456',
      challengeId: 'c0000000-0000-0000-0000-000000000001',
    });
    mockSendSignInCodeEmail.mockResolvedValue({ sent: true });
  });

  it('returns 200 { success: true, challengeId } and sends the code by email', async () => {
    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.challengeId).toBe('c0000000-0000-0000-0000-000000000001');
    expect(mockCreateSignInCode).toHaveBeenCalledWith('user@example.com');
    expect(mockSendSignInCodeEmail).toHaveBeenCalledWith('user@example.com', '123456');
  });

  it('checks eligibility before issuing a code', async () => {
    await POST(createRequest({ email: 'user@example.com' }));

    expect(mockCheckEmailSignInEligibility).toHaveBeenCalledWith(
      'user@example.com',
      expect.any(NextRequest)
    );
  });

  it('passes through eligibility failure status and body verbatim', async () => {
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 429,
      errorCode: 'SIGNUP-RATE-LIMITED',
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data).toEqual({ success: false, error: 'SIGNUP-RATE-LIMITED' });
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
    expect(mockSendSignInCodeEmail).not.toHaveBeenCalled();
  });

  it('keeps signup-only email rejection opaque to prevent account enumeration', async () => {
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 400,
      errorCode: 'INVALID_EMAIL',
      body: { success: false, error: 'Email addresses with + aliases are not allowed.' },
    });

    const response = await POST(createRequest({ email: 'new+alias@example.com' }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.challengeId).toMatch(UUID_REGEX);
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
  });

  it('returns opaque 200 with a challengeId for a blocked domain', async () => {
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: 'BLOCKED',
      body: { success: false, error: 'BLOCKED' },
    });

    const response = await POST(createRequest({ email: 'user@blocked.example.com' }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.challengeId).toMatch(UUID_REGEX);
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
    expect(mockSendSignInCodeEmail).not.toHaveBeenCalled();
  });

  it('returns identical body shape for blocked domain and eligible email', async () => {
    // Eligible response
    const eligibleResponse = await POST(createRequest({ email: 'eligible@example.com' }));
    const eligibleData = await eligibleResponse.json();

    // BLOCKED response
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: 'BLOCKED',
      body: { success: false, error: 'BLOCKED' },
    });
    const blockedResponse = await POST(createRequest({ email: 'blocked@example.com' }));
    const blockedData = await blockedResponse.json();

    expect(eligibleResponse.status).toBe(200);
    expect(blockedResponse.status).toBe(200);
    expect(eligibleData).toHaveProperty('success', true);
    expect(eligibleData).toHaveProperty('challengeId');
    expect(blockedData).toHaveProperty('success', true);
    expect(blockedData).toHaveProperty('challengeId');
    expect(eligibleData.challengeId).toMatch(UUID_REGEX);
    expect(blockedData.challengeId).toMatch(UUID_REGEX);
    // Different challenge IDs (eligible real, blocked fake)
    expect(eligibleData.challengeId).not.toBe(blockedData.challengeId);
  });

  it('allows a grandfathered user on a blocked TLD to sign in', async () => {
    // Grandfathered users have existingUser: true in domain eligibility,
    // which means checkEmailSignInEligibility returns { ok: true } even on a blocked TLD.
    mockCheckEmailSignInEligibility.mockResolvedValue({ ok: true });

    const response = await POST(createRequest({ email: 'existing@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.challengeId).toBe('c0000000-0000-0000-0000-000000000001');
    expect(mockCreateSignInCode).toHaveBeenCalledWith('existing@example.com');
    expect(mockSendSignInCodeEmail).toHaveBeenCalled();
  });

  it('returns indistinguishable status and body shape for blocked and grandfathered .zzz addresses', async () => {
    // Blocked .zzz address — no code issued, no email sent
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: 'BLOCKED',
      body: { success: false, error: 'BLOCKED' },
    });
    const blockedResponse = await POST(createRequest({ email: 'user@blocked.zzz' }));
    const blockedData = await blockedResponse.json();

    expect(blockedResponse.status).toBe(200);
    expect(blockedData.success).toBe(true);
    expect(blockedData.challengeId).toMatch(UUID_REGEX);
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
    expect(mockSendSignInCodeEmail).not.toHaveBeenCalled();

    // Grandfathered .zzz address (existingUser: true) — real code issued, real email sent
    mockCheckEmailSignInEligibility.mockResolvedValue({ ok: true });
    const grandfatheredResponse = await POST(createRequest({ email: 'grandfathered@example.zzz' }));
    const grandfatheredData = await grandfatheredResponse.json();

    expect(grandfatheredResponse.status).toBe(200);
    expect(grandfatheredData.success).toBe(true);
    expect(grandfatheredData.challengeId).toBe('c0000000-0000-0000-0000-000000000001');
    expect(mockCreateSignInCode).toHaveBeenCalledWith('grandfathered@example.zzz');
    expect(mockSendSignInCodeEmail).toHaveBeenCalled();

    // Status and body shape equality — an observer cannot distinguish the two cases
    expect(blockedResponse.status).toBe(grandfatheredResponse.status);
    expect(typeof blockedData.success).toBe(typeof grandfatheredData.success);
    expect(typeof blockedData.challengeId).toBe(typeof grandfatheredData.challengeId);
  });

  it('preserves SSO_ERROR with ssoOrganizationId', async () => {
    mockCheckEmailSignInEligibility.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: 'SSO_ERROR',
      body: {
        success: false,
        error: 'Sign in with your organization SSO provider.',
        ssoOrganizationId: 'org_abc123',
      },
    });

    const response = await POST(createRequest({ email: 'user@sso.example.com' }));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data).toEqual({
      success: false,
      error: 'SSO_ERROR',
      ssoOrganizationId: 'org_abc123',
    });
  });

  it.each([
    ['neverbounce_rejected' as const, 400, 'INVALID_EMAIL'],
    ['provider_not_configured' as const, 500, 'EMAIL_DELIVERY_FAILED'],
  ])(
    'reports %s delivery failures and deletes the unusable code',
    async (reason, status, error) => {
      mockSendSignInCodeEmail.mockResolvedValue({ sent: false, reason });

      const response = await POST(createRequest({ email: 'user@example.com' }));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ success: false, error });
      expect(mockDeleteSignInCode).toHaveBeenCalledWith('user@example.com', '123456');
    }
  );

  it('returns an identical success body whether or not the user exists (anti-enumeration)', async () => {
    const existingUserResponse = await POST(createRequest({ email: 'exists@example.com' }));
    const newUserResponse = await POST(createRequest({ email: 'new@example.com' }));

    expect(await existingUserResponse.json()).toEqual(await newUserResponse.json());
    expect(existingUserResponse.status).toBe(newUserResponse.status);
  });

  it('returns 400 for an invalid body', async () => {
    const response = await POST(createRequest({ email: 'not-an-email' }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'INVALID_REQUEST' });
    expect(mockCheckEmailSignInEligibility).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing email', async () => {
    const response = await POST(createRequest({}));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'INVALID_REQUEST' });
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await POST(createMalformedRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'INVALID_REQUEST' });
  });

  describe('timing floor', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('enforces the 250 ms floor on the eligible branch', async () => {
      let resolved = false;
      const promise = POST(createRequest({ email: 'user@example.com' }));
      void promise.then(() => {
        resolved = true;
      });

      // Drain non-timer async work — the promise must still be pending
      // because setTimeout has not fired.
      await Promise.resolve();
      expect(resolved).toBe(false);

      // At 249 ms the floor has not expired.
      await jest.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);

      // At 250 ms the floor expires and the response resolves.
      await jest.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(resolved).toBe(true);
      expect(response.status).toBe(200);
    });

    it('enforces the 250 ms floor on the blocked branch', async () => {
      mockCheckEmailSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'BLOCKED',
        body: { success: false, error: 'BLOCKED' },
      });

      let resolved = false;
      const promise = POST(createRequest({ email: 'blocked@example.com' }));
      void promise.then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(resolved).toBe(true);
      expect(response.status).toBe(200);
    });

    it('enforces the 250 ms floor on the 400 invalid-body branch', async () => {
      let resolved = false;
      const promise = POST(createRequest({ email: 'not-an-email' }));
      void promise.then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(resolved).toBe(true);
      expect(response.status).toBe(400);
    });

    it('enforces the floor on the SSO_ERROR branch', async () => {
      mockCheckEmailSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        body: {
          success: false,
          error: 'Sign in with your organization SSO provider.',
          ssoOrganizationId: 'org_abc123',
        },
      });

      let resolved = false;
      const promise = POST(createRequest({ email: 'user@sso.example.com' }));
      void promise.then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(resolved).toBe(true);
      expect(response.status).toBe(403);
    });

    it('enforces the floor on the email delivery failure branch', async () => {
      mockSendSignInCodeEmail.mockResolvedValue({ sent: false, reason: 'provider_not_configured' });

      let resolved = false;
      const promise = POST(createRequest({ email: 'user@example.com' }));
      void promise.then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(249);
      expect(resolved).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const response = await promise;

      expect(resolved).toBe(true);
      expect(response.status).toBe(500);
    });
  });
});
