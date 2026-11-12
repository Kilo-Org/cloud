jest.mock('@/lib/auth/pending-link', () => ({
  claimEmailCodeSend: jest.fn(),
  getPendingLinkBySecret: jest.fn(),
  readPendingLinkSecret: jest.fn(),
  releaseEmailCodeSend: jest.fn(),
  setPendingLinkEmailChallenge: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/magic-link-tokens', () => ({
  createSignInCode: jest.fn(),
  deleteSignInCode: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/email', () => ({
  sendAccountLinkCodeEmail: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
jest.mock('@/lib/auth/email-signin-eligibility', () => ({
  checkEmailSignInEligibility: jest.fn(),
}));

import { POST } from './route';
import {
  claimEmailCodeSend,
  getPendingLinkBySecret,
  readPendingLinkSecret,
  releaseEmailCodeSend,
  setPendingLinkEmailChallenge,
} from '@/lib/auth/pending-link';
import { createSignInCode } from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { sendAccountLinkCodeEmail } from '@kilocode/web-shared/lib/email';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';

const mockReadSecret = jest.mocked(readPendingLinkSecret);
const mockGetPending = jest.mocked(getPendingLinkBySecret);
const mockClaim = jest.mocked(claimEmailCodeSend);
const mockRelease = jest.mocked(releaseEmailCodeSend);
const mockSetChallenge = jest.mocked(setPendingLinkEmailChallenge);
const mockCreateCode = jest.mocked(createSignInCode);
const mockSend = jest.mocked(sendAccountLinkCodeEmail);
const mockFindUser = jest.mocked(findUserById);
const mockEligibility = jest.mocked(checkEmailSignInEligibility);

const liveRow = {
  id: 'pending-1',
  kilo_user_id: 'user-1',
  provider: 'github',
  email_code_allowed: true,
} as never;

const requestUrl = 'http://localhost:3000/api/auth/pending-link/email-code';
const appOrigin = new URL(requestUrl).origin;
const appHost = new URL(requestUrl).host;

function codeRequest(headers: Record<string, string> = {}) {
  return new Request(requestUrl, {
    method: 'POST',
    headers: { Origin: appOrigin, Host: appHost, ...headers },
  });
}

describe('POST /api/auth/pending-link/email-code', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadSecret.mockResolvedValue('secret-1');
    mockGetPending.mockResolvedValue(liveRow);
    mockFindUser.mockResolvedValue({
      id: 'user-1',
      google_user_email: 'user@example.com',
      blocked_reason: null,
    } as never);
    mockEligibility.mockResolvedValue({ ok: true } as never);
  });

  it('answers 429 TOO_MANY_CODES when the per-row send cap is spent', async () => {
    mockClaim.mockResolvedValue(false);

    const response = await POST(codeRequest());

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'TOO_MANY_CODES' });
    expect(mockCreateCode).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an account whose block timestamp is set', async () => {
    mockFindUser.mockResolvedValue({
      id: 'user-1',
      google_user_email: 'user@example.com',
      blocked_at: '2026-01-15T12:00:00.000Z',
      blocked_reason: null,
    } as never);

    const response = await POST(codeRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'BLOCKED' });
    expect(mockCreateCode).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('claims a send, stores the challenge, and sends the code', async () => {
    mockClaim.mockResolvedValue(true);
    mockCreateCode.mockResolvedValue({ code: '123456', challengeId: 'challenge-1' });
    mockSend.mockResolvedValue({ sent: true });

    const response = await POST(codeRequest());

    expect(response.status).toBe(200);
    expect(mockSetChallenge).toHaveBeenCalledWith('secret-1', 'challenge-1');
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('returns the claimed send when delivery fails', async () => {
    mockClaim.mockResolvedValue(true);
    mockCreateCode.mockResolvedValue({ code: '123456', challengeId: 'challenge-1' });
    mockSend.mockResolvedValue({ sent: false, reason: 'provider_not_configured' });

    const response = await POST(codeRequest());

    expect(response.status).toBe(502);
    expect(mockRelease).toHaveBeenCalledWith('secret-1');
  });

  it('refuses a foreign Origin before reading the link', async () => {
    const response = await POST(codeRequest({ Origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'INVALID_ORIGIN' });
    expect(mockReadSecret).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
