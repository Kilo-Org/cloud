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
    mockCreateSignInCode.mockResolvedValue('123456');
    mockSendSignInCodeEmail.mockResolvedValue({ sent: true });
  });

  it('returns 200 { success: true } and sends the code by email', async () => {
    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true });
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
    expect(await response.json()).toEqual({ success: true });
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
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
});
