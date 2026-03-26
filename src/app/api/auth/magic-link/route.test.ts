import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import {
  createMagicLinkToken,
  type MagicLinkTokenWithPlaintext,
} from '@/lib/auth/magic-link-tokens';
import { sendMagicLinkEmail } from '@/lib/email';
import { findUserByEmail } from '@/lib/user';
import { MAGIC_LINK_EMAIL_ERRORS } from '@/lib/schemas/email';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth/verify-turnstile-jwt');
jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/email');
jest.mock('@/lib/user');

import { POST } from './route';

const mockVerifyTurnstileJWT = jest.mocked(verifyTurnstileJWT);
const mockCreateMagicLinkToken = jest.mocked(createMagicLinkToken);
const mockSendMagicLinkEmail = jest.mocked(sendMagicLinkEmail);
const mockFindUserByEmail = jest.mocked(findUserByEmail);

describe('POST /api/auth/magic-link', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  const mockMagicLinkToken: MagicLinkTokenWithPlaintext = {
    token_hash: 'hash123',
    email: 'user@example.com',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
    plaintext_token: 'plaintext123',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: Turnstile verification succeeds
    mockVerifyTurnstileJWT.mockResolvedValue({
      success: true,
      token: {
        ip: '192.168.1.1',
        guid: '00000000-0000-0000-0000-000000000000',
        iat: 1234567890,
        exp: 1234567890 + 3600,
      },
    });

    // Default: Magic link creation succeeds
    mockCreateMagicLinkToken.mockResolvedValue(mockMagicLinkToken);
    mockSendMagicLinkEmail.mockResolvedValue({ sent: true });

    // Default: User does not exist (new user signup)
    mockFindUserByEmail.mockResolvedValue(undefined);
  });

  it('should send magic link for valid email with valid JWT', async () => {
    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      message: 'Magic link sent to your email',
    });

    expect(mockVerifyTurnstileJWT).toHaveBeenCalledWith('magic-link');
    expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user@example.com');
    expect(mockSendMagicLinkEmail).toHaveBeenCalledWith(mockMagicLinkToken, undefined);
  });

  it('should reject request with invalid Turnstile JWT', async () => {
    const errorResponse = NextResponse.json(
      { error: 'Security verification required' },
      { status: 401 }
    );

    mockVerifyTurnstileJWT.mockResolvedValue({
      success: false,
      response: errorResponse,
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Security verification required' });
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('should reject request with invalid email format', async () => {
    const response = await POST(createRequest({ email: 'not-an-email' }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  it('should reject request with missing email', async () => {
    const response = await POST(createRequest({}));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  it('should validate email format before checking Turnstile', async () => {
    // This test verifies the current behavior: email validation happens first
    // This is correct - we should fail fast on invalid request format
    const errorResponse = NextResponse.json(
      { error: 'Security verification required' },
      { status: 401 }
    );

    mockVerifyTurnstileJWT.mockResolvedValue({
      success: false,
      response: errorResponse,
    });

    const response = await POST(createRequest({ email: 'not-an-email' }));
    const data = await response.json();

    // Email validation fails first with 400, Turnstile check never runs
    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  describe('magic link signup email validation', () => {
    it('should reject uppercase email for new users', async () => {
      mockFindUserByEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'User@Example.com' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ success: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
      expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    });

    it('should reject email with + for new users', async () => {
      mockFindUserByEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'user+tag@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ success: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
      expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    });

    it('should allow uppercase email for existing users (sign-in)', async () => {
      mockFindUserByEmail.mockResolvedValue({
        id: 'existing-user-id',
        google_user_email: 'User@Example.com',
      } as Awaited<ReturnType<typeof findUserByEmail>>);

      const response = await POST(createRequest({ email: 'User@Example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('User@Example.com');
    });

    it('should allow email with + for existing users (sign-in)', async () => {
      mockFindUserByEmail.mockResolvedValue({
        id: 'existing-user-id',
        google_user_email: 'user+tag@example.com',
      } as Awaited<ReturnType<typeof findUserByEmail>>);

      const response = await POST(createRequest({ email: 'user+tag@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user+tag@example.com');
    });

    it('should allow valid lowercase email without + for new users', async () => {
      mockFindUserByEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'user@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user@example.com');
    });
  });
});
