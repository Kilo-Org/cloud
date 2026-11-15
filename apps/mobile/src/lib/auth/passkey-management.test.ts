import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postAuth, type PostAuthFailure } from '@/lib/auth/auth-fetch';
import {
  authorizePasskeyManagementWithCode,
  collectPasskeyManagementSso,
  requestManagementCode,
  startPasskeyManagementSso,
} from '@/lib/auth/passkey-management';
import { resolveAdmission } from '@/lib/auth/resolve-admission';

vi.mock('@/lib/auth/auth-fetch', () => ({ postAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-header', () => ({ buildAuthHeaders: () => ({}) }));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: () => Promise.resolve('token'),
}));
vi.mock('@/lib/auth/resolve-admission', () => ({ resolveAdmission: vi.fn() }));

const postAuthMock = vi.mocked(postAuth);
const resolveAdmissionMock = vi.mocked(resolveAdmission);

const ADMISSION = {
  platform: 'ios' as const,
  kind: 'assertion' as const,
  challenge: 'device-challenge',
  payload: 'device-proof',
};

const ok = (data: unknown) => ({ ok: true as const, data });

function refusal(
  errorCode: string,
  httpStatus: number,
  ssoOrganizationId?: string
): PostAuthFailure {
  return { ok: false, errorCode, ssoOrganizationId, httpStatus, terminal: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAdmissionMock.mockResolvedValue({ admission: ADMISSION });
});

/**
 * The management wire: which server answer means "this domain needs the
 * browser approval", and what each leg of that approval actually sends.
 *
 * `SSO_ERROR` is two answers. A 403 that names the organization requires
 * single sign-on, so the app hands off to the browser. A 503 is the domain's
 * SSO policy or provider being unreachable, which the approval page cannot
 * fix; treating it as a handoff would trap the person in a loop that cannot
 * succeed.
 */
describe('management proof refusals', () => {
  it('treats a 403 SSO_ERROR naming the organization as the browser handoff', async () => {
    postAuthMock.mockResolvedValue(refusal('SSO_ERROR', 403, 'org-1'));

    await expect(requestManagementCode('person@example.com')).resolves.toEqual({
      status: 'error',
      failure: 'sso-required',
    });
  });

  it('keeps a 503 SSO_ERROR retryable instead of routing to the browser', async () => {
    postAuthMock.mockResolvedValue(refusal('SSO_ERROR', 503));

    await expect(requestManagementCode('person@example.com')).resolves.toEqual({
      status: 'error',
      failure: 'retryable',
    });
  });

  it('does not hand off on a 403 that names no organization', async () => {
    postAuthMock.mockResolvedValue(refusal('SSO_ERROR', 403));

    await expect(requestManagementCode('person@example.com')).resolves.toEqual({
      status: 'error',
      failure: 'retryable',
    });
  });

  it('classifies the mint the same way as the code request', async () => {
    postAuthMock.mockResolvedValueOnce(refusal('SSO_ERROR', 403, 'org-1'));
    await expect(
      authorizePasskeyManagementWithCode({
        operation: 'rename',
        email: 'person@example.com',
        code: '123456',
        challengeId: 'challenge-1',
      })
    ).resolves.toEqual({ status: 'error', failure: 'sso-required' });

    postAuthMock.mockResolvedValueOnce(refusal('SSO_ERROR', 503));
    await expect(
      authorizePasskeyManagementWithCode({
        operation: 'rename',
        email: 'person@example.com',
        code: '123456',
        challengeId: 'challenge-1',
      })
    ).resolves.toEqual({ status: 'error', failure: 'retryable' });
  });

  it('sends the device proof with the code it redeems', async () => {
    postAuthMock.mockResolvedValue(ok({ authorization: 'grant-1', expiresIn: 300 }));

    await authorizePasskeyManagementWithCode({
      operation: 'remove',
      email: 'person@example.com',
      code: '123456',
      challengeId: 'challenge-1',
    });

    expect(postAuthMock).toHaveBeenCalledWith(
      '/api/auth/passkey/management/authorize',
      {
        proof: 'email',
        operation: 'remove',
        email: 'person@example.com',
        code: '123456',
        challengeId: 'challenge-1',
        admission: ADMISSION,
      },
      {}
    );
  });
});

/**
 * The two legs of the SSO approval. The start proves the device and opens the
 * page; the poll carries the request id and the bearer only, because the
 * device proof was already verified and a poll must stay cheap.
 */
describe('SSO approval wire', () => {
  it('starts with the operation and the device proof', async () => {
    postAuthMock.mockResolvedValue(
      ok({
        requestId: '5e0d2c9e-1c1a-4b6e-9f0e-1d2c3b4a5e6f',
        approvalUrl: 'https://app.kilo.ai/passkey-approval?request=5e0d2c9e',
        expiresIn: 600,
      })
    );

    const started = await startPasskeyManagementSso({ operation: 'enroll' });

    expect(postAuthMock).toHaveBeenCalledWith(
      '/api/auth/passkey/management/sso/start',
      { operation: 'enroll', admission: ADMISSION },
      {}
    );
    expect(started).toEqual({
      status: 'approval-required',
      requestId: '5e0d2c9e-1c1a-4b6e-9f0e-1d2c3b4a5e6f',
      approvalUrl: 'https://app.kilo.ai/passkey-approval?request=5e0d2c9e',
      expiresAtMs: expect.any(Number),
    });
  });

  it('reports an admission read that never produced a request', async () => {
    resolveAdmissionMock.mockRejectedValue(new Error('challenge failed'));

    await expect(startPasskeyManagementSso({ operation: 'enroll' })).resolves.toEqual({
      status: 'error',
      failure: 'reported',
    });
    expect(postAuthMock).not.toHaveBeenCalled();
  });

  it('separates a domain that needs no SSO from an SSO provider that is down', async () => {
    postAuthMock.mockResolvedValueOnce(refusal('SSO_NOT_REQUIRED', 403));
    await expect(startPasskeyManagementSso({ operation: 'enroll' })).resolves.toEqual({
      status: 'error',
      failure: 'sso-not-required',
    });

    postAuthMock.mockResolvedValueOnce(refusal('SSO_ERROR', 503));
    await expect(startPasskeyManagementSso({ operation: 'enroll' })).resolves.toEqual({
      status: 'error',
      failure: 'sso-unavailable',
    });
  });

  it('polls with the request id only', async () => {
    postAuthMock.mockResolvedValue(refusal('SSO_APPROVAL_PENDING', 425));

    await expect(collectPasskeyManagementSso({ requestId: 'request-1' })).resolves.toEqual({
      status: 'pending',
    });
    expect(postAuthMock).toHaveBeenCalledWith(
      '/api/auth/passkey/management/sso/collect',
      { requestId: 'request-1' },
      {}
    );
  });

  it('returns the grant the browser leg minted', async () => {
    postAuthMock.mockResolvedValue(ok({ authorization: 'grant-1', expiresIn: 300 }));

    const collected = await collectPasskeyManagementSso({ requestId: 'request-1' });

    expect(collected).toEqual({
      status: 'authorized',
      authorization: 'grant-1',
      expiresAtMs: expect.any(Number),
    });
    if (collected.status === 'authorized') {
      // The window comes from the server's own answer, never from the client.
      expect(collected.expiresAtMs).toBeGreaterThan(Date.now());
      expect(collected.expiresAtMs).toBeLessThanOrEqual(Date.now() + 300_000);
    }
  });

  it('stops polling on a request the server no longer holds', async () => {
    postAuthMock.mockResolvedValue(refusal('SSO_APPROVAL_INVALID', 403));

    await expect(collectPasskeyManagementSso({ requestId: 'request-1' })).resolves.toEqual({
      status: 'error',
      failure: 'expired',
    });
  });
});
