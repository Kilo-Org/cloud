jest.mock('@/lib/auth/pending-link', () => ({
  clearPendingLinkCookie: jest.fn(),
  completePendingLink: jest.fn(),
  getPendingLinkBySecret: jest.fn(),
  readPendingLinkSecret: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/magic-link-tokens', () => ({
  commitSignInCode: jest.fn(),
  consumeSignInCode: jest.fn(),
  createMagicLinkToken: jest.fn(),
  releaseSignInCode: jest.fn(),
  reserveSignInCode: jest.fn(),
  SIGN_IN_CODE_MAX_ATTEMPTS: 5,
}));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
jest.mock('@/lib/auth/email-signin-eligibility', () => ({
  checkDomainSignInEligibility: jest.fn(),
}));

import { POST } from './route';
import {
  completePendingLink,
  getPendingLinkBySecret,
  readPendingLinkSecret,
} from '@/lib/auth/pending-link';
import {
  commitSignInCode,
  createMagicLinkToken,
  reserveSignInCode,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';

const mockReadSecret = jest.mocked(readPendingLinkSecret);
const mockGetPending = jest.mocked(getPendingLinkBySecret);
const mockComplete = jest.mocked(completePendingLink);
const mockReserve = jest.mocked(reserveSignInCode);
const mockCommit = jest.mocked(commitSignInCode);
const mockMagic = jest.mocked(createMagicLinkToken);
const mockFindUser = jest.mocked(findUserById);
const mockEligibility = jest.mocked(checkDomainSignInEligibility);

function pendingRow(challengeId: string | null) {
  return {
    id: 'pending-1',
    kilo_user_id: 'user-1',
    kind: 'existing_account',
    provider: 'github',
    email_code_allowed: true,
    email_code_challenge_id: challengeId,
    callback_path: null,
  } as never;
}

function verifyRequest() {
  return new Request('http://localhost:3000/api/auth/pending-link/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '123456' }),
  });
}

describe('POST /api/auth/pending-link/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadSecret.mockResolvedValue('secret-1');
    mockFindUser.mockResolvedValue({
      id: 'user-1',
      google_user_email: 'user@example.com',
      blocked_reason: null,
    } as never);
    mockEligibility.mockResolvedValue({ ok: true, existingUser: true } as never);
  });

  it('answers 409 CODE_NOT_REQUESTED and never reserves without a challenge', async () => {
    mockGetPending.mockResolvedValue(pendingRow(null));

    const response = await POST(verifyRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'CODE_NOT_REQUESTED' });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('reserves with the stored challenge and signs in on success', async () => {
    mockGetPending.mockResolvedValue(pendingRow('challenge-1'));
    mockReserve.mockResolvedValue('ok');
    mockComplete.mockResolvedValue({ status: 'linked', provider: 'github' });
    mockCommit.mockResolvedValue(true);
    mockMagic.mockResolvedValue({ plaintext_token: 'magic-1' } as never);

    const response = await POST(verifyRequest());

    expect(response.status).toBe(200);
    expect(mockReserve).toHaveBeenCalledWith('user@example.com', '123456', 'challenge-1');
    expect(await response.json()).toMatchObject({ token: 'magic-1' });
  });
});
