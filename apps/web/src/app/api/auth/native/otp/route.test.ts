import { createSignInCode } from '@/lib/auth/magic-link-tokens';
import { sendSignInCodeEmail } from '@/lib/email';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/email');
jest.mock('@/lib/auth/email-signin-eligibility');

import { POST } from './route';

const mockCreateSignInCode = jest.mocked(createSignInCode);
const mockSendSignInCodeEmail = jest.mocked(sendSignInCodeEmail);
const mockCheckEmailSignInEligibility = jest.mocked(checkEmailSignInEligibility);

describe('POST /api/auth/native/otp', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/native/otp', {
      method: 'POST',
      body: JSON.stringify(body),
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
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data).toEqual({ success: false, error: 'Rate limit exceeded. Please try again later.' });
    expect(mockCreateSignInCode).not.toHaveBeenCalled();
    expect(mockSendSignInCodeEmail).not.toHaveBeenCalled();
  });

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
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockCheckEmailSignInEligibility).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing email', async () => {
    const response = await POST(createRequest({}));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
  });
});
