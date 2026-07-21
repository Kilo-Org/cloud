/**
 * @jest-environment node
 */
import { TRPCError } from '@trpc/server';

const getGitHubUserAccessToken = jest.fn();

jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({
  getGitHubUserAccessToken: (...args: unknown[]) => getGitHubUserAccessToken(...args),
}));

jest.mock('./client', () => ({
  createGitHubPrReviewOctokit: (token: string) => ({ __token: token }),
}));

import { withGitHubUserTokenRetry } from './retry';

function connected(token: string, authorizationId: string, credentialVersion: number) {
  return {
    status: 'connected' as const,
    credential: {
      token,
      expiresAtEpochMs: Date.now() + 3_600_000,
      githubLogin: 'octocat',
      authorizationId,
      credentialVersion,
    },
  };
}

function http401() {
  return { status: 401, message: 'Bad credentials' };
}

beforeEach(() => {
  getGitHubUserAccessToken.mockReset();
});

describe('withGitHubUserTokenRetry', () => {
  it('returns the result when the first call succeeds (no rotate)', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const call = jest.fn().mockResolvedValue('ok');

    const result = await withGitHubUserTokenRetry({ kiloUserId: 'u1', call });

    expect(result).toBe('ok');
    expect(getGitHubUserAccessToken).toHaveBeenCalledTimes(1);
    expect(getGitHubUserAccessToken).toHaveBeenCalledWith('u1', { op: 'fetch' });
  });

  it('rotates and retries once on a raw 401, then succeeds', async () => {
    getGitHubUserAccessToken
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1)) // fetch
      .mockResolvedValueOnce(connected('t2', 'auth_1', 2)); // rotate
    const call = jest.fn().mockRejectedValueOnce(http401()).mockResolvedValueOnce('recovered');

    const result = await withGitHubUserTokenRetry({ kiloUserId: 'u1', call });

    expect(result).toBe('recovered');
    expect(getGitHubUserAccessToken).toHaveBeenNthCalledWith(2, 'u1', {
      op: 'rotate',
      staleAuthorizationId: 'auth_1',
      staleCredentialVersion: 1,
    });
    // second call used the rotated token
    expect(call).toHaveBeenNthCalledWith(2, { __token: 't2' });
  });

  it('reports the rotated credential and throws PRECONDITION_FAILED on a second 401', async () => {
    getGitHubUserAccessToken
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1)) // fetch
      .mockResolvedValueOnce(connected('t2', 'auth_1', 2)) // rotate
      .mockResolvedValueOnce({ status: 'disconnected', reason: 'revoked' }); // reportRejected
    const call = jest.fn().mockRejectedValue(http401());

    await expect(withGitHubUserTokenRetry({ kiloUserId: 'u1', call })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(getGitHubUserAccessToken).toHaveBeenNthCalledWith(3, 'u1', {
      op: 'reportRejected',
      authorizationId: 'auth_1',
      credentialVersion: 2,
    });
  });

  it('classifies a raw non-401 error without rotating', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const call = jest.fn().mockRejectedValue({ status: 404, message: 'Not Found' });

    await expect(withGitHubUserTokenRetry({ kiloUserId: 'u1', call })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // only the initial fetch — no rotate
    expect(getGitHubUserAccessToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces an already-classified TRPCError unchanged', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce(connected('t1', 'auth_1', 1));
    const call = jest.fn().mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'nope' }));

    await expect(withGitHubUserTokenRetry({ kiloUserId: 'u1', call })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(getGitHubUserAccessToken).toHaveBeenCalledTimes(1);
  });

  it('throws PRECONDITION_FAILED when the user is disconnected', async () => {
    getGitHubUserAccessToken.mockResolvedValueOnce({
      status: 'disconnected',
      reason: 'not_connected',
    });
    const call = jest.fn();

    await expect(withGitHubUserTokenRetry({ kiloUserId: 'u1', call })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(call).not.toHaveBeenCalled();
  });
});
