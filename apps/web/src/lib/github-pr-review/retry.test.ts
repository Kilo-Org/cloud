/**
 * @jest-environment node
 */
import { TRPCError } from '@trpc/server';

const getGitHubUserAccessToken = jest.fn();
const createGitHubPrReviewOctokit = jest.fn((token: string) => ({ __token: token }));

jest.mock('@/lib/integrations/platforms/github/user-token-client', () => ({
  getGitHubUserAccessToken: (...args: unknown[]) => getGitHubUserAccessToken(...args),
}));

jest.mock('./client', () => ({
  createGitHubPrReviewOctokit: (token: string) => createGitHubPrReviewOctokit(token),
}));

import { withGitHubReviewIdentity, withGitHubUserTokenRetry } from './retry';

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
  createGitHubPrReviewOctokit.mockReset().mockImplementation(token => ({ __token: token }));
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

describe('scoped GitHub review identity', () => {
  const identity = { accountId: 'u1', authorizationId: 'auth_1', actorId: '101' };

  it('rejects another account before its protected call', async () => {
    getGitHubUserAccessToken.mockResolvedValue(connected('t1', 'auth_1', 1));
    const effects: string[] = [];
    await expect(
      withGitHubReviewIdentity(identity, () =>
        withGitHubUserTokenRetry({
          kiloUserId: 'u2',
          call: async () => {
            effects.push('wrong-account');
            return 'sent';
          },
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'review_identity_or_revision_changed' });
    expect(effects).toEqual([]);
  });

  it('isolates overlapping scopes across awaits and leaves concurrent direct calls unscoped', async () => {
    getGitHubUserAccessToken.mockImplementation(async userId =>
      connected(userId, `auth_${userId}`, 1)
    );
    createGitHubPrReviewOctokit.mockImplementation(token => ({
      __token: token,
      users: {
        getAuthenticated: async () => {
          if (token === 'u3') throw new Error('Direct calls must not query actor identity');
          return { data: { id: token === 'u1' ? 101 : 102 } };
        },
      },
    }));
    const effects: string[] = [];
    const call = async (client: unknown) => {
      const token = (client as { __token: string }).__token;
      effects.push(token);
      return token;
    };
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    const start = (userId: string, actorId: string, gate: Promise<void>) =>
      withGitHubReviewIdentity(
        { accountId: userId, authorizationId: `auth_${userId}`, actorId },
        async () => {
          await gate;
          const result = await withGitHubUserTokenRetry({ kiloUserId: userId, call });
          await expect(
            withGitHubUserTokenRetry({ kiloUserId: userId === 'u1' ? 'u2' : 'u1', call })
          ).rejects.toMatchObject({ code: 'CONFLICT' });
          return result;
        }
      );
    const first = start('u1', '101', firstGate.promise);
    const second = start('u2', '102', secondGate.promise);
    expect(await withGitHubUserTokenRetry({ kiloUserId: 'u3', call })).toBe('u3');
    firstGate.resolve();
    expect(await first).toBe('u1');
    secondGate.resolve();
    expect(await second).toBe('u2');
    expect(await withGitHubUserTokenRetry({ kiloUserId: 'u3', call })).toBe('u3');
    expect(effects).toEqual(['u3', 'u1', 'u2', 'u3']);
  });

  it('retains unscoped rotation to a replacement authorization after a scoped rejection', async () => {
    getGitHubUserAccessToken.mockResolvedValue(connected('t2', 'auth_2', 2));
    const effects: string[] = [];
    await expect(
      withGitHubReviewIdentity(identity, () =>
        withGitHubUserTokenRetry({
          kiloUserId: 'u1',
          call: async () => {
            effects.push('scoped');
            return 'sent';
          },
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    getGitHubUserAccessToken
      .mockResolvedValueOnce(connected('t1', 'auth_1', 1))
      .mockResolvedValueOnce(connected('t2', 'auth_2', 2));
    expect(
      await withGitHubUserTokenRetry({
        kiloUserId: 'u1',
        call: async client => {
          const token = (client as typeof client & { __token: string }).__token;
          if (token === 't1') throw http401();
          effects.push(token);
          return 'completed';
        },
      })
    ).toBe('completed');
    expect(effects).toEqual(['t2']);
  });

  it.each([false, true])(
    'handles identity lookup 401 through normal rotation: rejected=%s',
    async rejected => {
      getGitHubUserAccessToken
        .mockResolvedValueOnce(connected('t1', 'auth_1', 1))
        .mockResolvedValueOnce(connected('t2', 'auth_1', 2))
        .mockResolvedValueOnce({ status: 'disconnected', reason: 'revoked' });
      createGitHubPrReviewOctokit.mockImplementation(token => ({
        __token: token,
        users: {
          getAuthenticated: async () => {
            if (token === 't1' || rejected) throw http401();
            return { data: { id: 101 } };
          },
        },
      }));
      const effects: string[] = [];
      const result = withGitHubReviewIdentity(identity, () =>
        withGitHubUserTokenRetry({
          kiloUserId: 'u1',
          call: async () => {
            effects.push('confirmed-actor');
            return 'completed';
          },
        })
      );
      if (rejected) {
        await expect(result).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'GitHub connection is no longer valid — reconnect',
        });
        expect(effects).toEqual([]);
      } else {
        expect(await result).toBe('completed');
        expect(effects).toEqual(['confirmed-actor']);
      }
    }
  );
});
