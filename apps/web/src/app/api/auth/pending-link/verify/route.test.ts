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
import { eq } from 'drizzle-orm';
import { auth_audit_logs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  authAuditEmailHash,
  setAuthActionSinkForTest,
  type AuthActionEvent,
} from '@/lib/auth/auth-audit';

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

const requestUrl = 'http://localhost:3000/api/auth/pending-link/verify';
const appOrigin = new URL(requestUrl).origin;
const appHost = new URL(requestUrl).host;

function verifyRequest(headers: Record<string, string> = {}) {
  return new Request(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: appOrigin, Host: appHost, ...headers },
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

  it('refuses an account whose block timestamp is set', async () => {
    mockGetPending.mockResolvedValue(pendingRow('challenge-1'));
    mockFindUser.mockResolvedValue({
      id: 'user-1',
      google_user_email: 'user@example.com',
      blocked_at: '2026-01-15T12:00:00.000Z',
      blocked_reason: null,
    } as never);

    const response = await POST(verifyRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'BLOCKED' });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses a foreign Origin before reading the link', async () => {
    const response = await POST(verifyRequest({ Origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'INVALID_ORIGIN' });
    expect(mockReadSecret).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/pending-link/verify audit', () => {
  const userId = `pending-link-verify-${crypto.randomUUID()}`;
  let events: AuthActionEvent[];

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    setAuthActionSinkForTest(event => events.push(event));
    mockReadSecret.mockResolvedValue('secret-1');
    mockGetPending.mockResolvedValue({
      ...(pendingRow(crypto.randomUUID()) as object),
      kilo_user_id: userId,
    } as never);
    mockFindUser.mockResolvedValue({
      id: userId,
      google_user_email: 'account@example.com',
      blocked_reason: null,
    } as never);
    mockEligibility.mockResolvedValue({ ok: true, existingUser: true } as never);
  });

  afterEach(async () => {
    setAuthActionSinkForTest(null);
    await db.delete(auth_audit_logs).where(eq(auth_audit_logs.user_id, userId));
  });

  async function rows() {
    return db.select().from(auth_audit_logs).where(eq(auth_audit_logs.user_id, userId));
  }

  it('stores a wrong code under the target account and its email hash', async () => {
    mockReserve.mockResolvedValue('invalid');

    expect((await POST(verifyRequest())).status).toBe(401);

    expect(await rows()).toEqual([
      expect.objectContaining({
        action: 'auth.sign_in_method.link',
        outcome: 'failure',
        method: 'github',
        failure_reason: 'invalid_code',
        subject_email_hash: authAuditEmailHash('account@example.com'),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('123456');
  });

  it('logs a locked-out code without a row', async () => {
    mockReserve.mockResolvedValue('too_many_attempts');

    expect((await POST(verifyRequest())).status).toBe(429);

    expect(await rows()).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ userId, failureReason: 'too_many_attempts', stored: false }),
    ]);
  });

  it('logs a missing pending link without a row', async () => {
    mockGetPending.mockResolvedValue(null as never);

    expect((await POST(verifyRequest())).status).toBe(404);

    expect(events).toEqual([
      expect.objectContaining({ userId: null, failureReason: 'expired', stored: false }),
    ]);
  });

  it('writes no row for a verified code, which the link records', async () => {
    mockReserve.mockResolvedValue('ok');
    mockComplete.mockResolvedValue({ status: 'linked', provider: 'github' });
    mockCommit.mockResolvedValue(true);
    mockMagic.mockResolvedValue({ plaintext_token: 'magic-1' } as never);

    expect((await POST(verifyRequest())).status).toBe(200);

    expect(await rows()).toEqual([]);
    expect(events).toEqual([]);
  });
});
