import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { NextResponse } from 'next/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { AccountBlockedError, AuthContextError, trpcErrorFormatter } from './transport';
import { createTRPCContext } from './init';

// The context is the only place the blocked-account refusal is decided, so the
// auth read is mocked at its module boundary; everything else (the budget
// wrapper, the exception, the formatter) runs for real.
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

/** A request the way the fetch adapter builds it, optionally naming its client. */
function requestAt(path: string, client?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: client === undefined ? undefined : { 'x-kilo-client': client },
  });
}

/** A failed auth read carries the response the caller would have returned. */
function failedAuthResponse(extra: {
  authorizationRefused?: boolean;
  refusalReason?: 'account_blocked';
}) {
  return {
    user: null,
    authFailedResponse: NextResponse.json(failureResult('Access denied'), { status: 403 }),
    ...extra,
  };
}

function createContext(client?: string): Promise<unknown> {
  return createTRPCContext({ req: requestAt('/api/trpc/user.getMe', client) });
}

function errorData(error: TRPCError, path: string) {
  return trpcErrorFormatter({
    shape: {
      message: error.message,
      code: -32603,
      data: { code: error.code, httpStatus: 403, path, stack: '' },
    },
    error,
  } as never).data;
}

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected createTRPCContext to reject');
    },
    (error: unknown) => error
  );
}

beforeEach(() => {
  mockedGetUserFromAuth.mockReset();
});

describe('createTRPCContext blocked-account refusal', () => {
  test('refuses a blocked mobile account with FORBIDDEN and the accountBlocked cause', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(createContext('mobile'));

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('FORBIDDEN');
    expect(trpcError.message).toBe('Account access is blocked');
    expect(trpcError.cause).toBeInstanceOf(AccountBlockedError);

    // What the mobile client actually reads: blocked-account data, and no
    // sign-out flag.
    const data = errorData(trpcError, 'user.getMe');
    expect(data.accountBlocked).toBe(true);
    expect(data.authRequired).toBeUndefined();
  });

  test('keeps a genuine missing session on UNAUTHORIZED with the auth context cause', async () => {
    mockedGetUserFromAuth.mockResolvedValue(failedAuthResponse({}));

    const error = await caught(createContext());

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('UNAUTHORIZED');
    expect(trpcError.cause).toBeInstanceOf(AuthContextError);
  });

  test('keeps an authorization refusal without a blocked-account reason on UNAUTHORIZED', async () => {
    mockedGetUserFromAuth.mockResolvedValue(failedAuthResponse({ authorizationRefused: true }));

    const error = await caught(createContext());

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('UNAUTHORIZED');
    expect(trpcError.cause).toBeInstanceOf(AuthContextError);
  });

  test('answers a blocked account without the client header on UNAUTHORIZED', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(createContext());

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('UNAUTHORIZED');
    expect(trpcError.cause).toBeInstanceOf(AuthContextError);

    // The merge-base web answer: sign-in -> after-sign-in -> /account-blocked
    // reads `authRequired`, and nothing reads `accountBlocked`.
    const data = errorData(trpcError, 'user.getMe');
    expect(data.authRequired).toBe(true);
    expect(data.accountBlocked).toBeUndefined();
  });

  test('answers a blocked account that names another client on UNAUTHORIZED', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(createContext('web'));

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('UNAUTHORIZED');
    expect(trpcError.cause).toBeInstanceOf(AuthContextError);

    const data = errorData(trpcError, 'user.getMe');
    expect(data.authRequired).toBe(true);
    expect(data.accountBlocked).toBeUndefined();
  });
});

describe('createTRPCContext revoked-account admission', () => {
  /** The auth read answers a live blocked account the way the real one does when
   *  the block is admitted: the session resolves and the refusal does not fire. */
  function blockedAccountAuthRead() {
    return {
      user: { id: 'user-1' } as never,
      deviceSessionId: 'device-1',
      authFailedResponse: null,
    };
  }

  const DEVICE = {
    type: 'mutation',
    calls: [{ path: 'user.revokeCurrentDeviceSession' }],
  } as const;

  test('admits the account for its own device-session revocation', async () => {
    mockedGetUserFromAuth.mockResolvedValue(blockedAccountAuthRead() as never);

    const context = (await createTRPCContext({
      req: requestAt('/api/trpc/user.revokeCurrentDeviceSession'),
      info: DEVICE as never,
    })) as { user: { id: string }; deviceSessionId?: string };

    // The auth read is asked to admit the block, which is what lets the revoke
    // reach the procedure instead of dying at the context gate.
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: true })
    );
    expect(context.user).toEqual({ id: 'user-1' });
    expect(context.deviceSessionId).toBe('device-1');
  });

  // Sign-out deletes the device's own token rows too; without that the device
  // keeps receiving notifications for the account it was told it cannot use.
  test.each([['user.unregisterPushToken'], ['user.unregisterActivityToken']])(
    'admits the account for its own %s',
    async path => {
      mockedGetUserFromAuth.mockResolvedValue(blockedAccountAuthRead() as never);

      const context = (await createTRPCContext({
        req: requestAt(`/api/trpc/${path}`),
        info: { type: 'mutation', calls: [{ path }] } as never,
      })) as { user: { id: string } };

      expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
        expect.objectContaining({ allowRefusedAccountSelfCleanup: true })
      );
      expect(context.user).toEqual({ id: 'user-1' });
    }
  );

  // tRPC reports a batched call's path with its query string; the gate matches
  // the bare procedure, so the strip is what admits a batched cleanup.
  test('admits a cleanup path that carries a query string', async () => {
    mockedGetUserFromAuth.mockResolvedValue(blockedAccountAuthRead() as never);

    const context = (await createTRPCContext({
      req: requestAt('/api/trpc/user.unregisterPushToken?batch=1'),
      info: { type: 'mutation', calls: [{ path: 'user.unregisterPushToken?batch=1' }] } as never,
    })) as { user: { id: string } };

    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: true })
    );
    expect(context.user).toEqual({ id: 'user-1' });
  });

  test('admits a batch of the three sign-out cleanups', async () => {
    mockedGetUserFromAuth.mockResolvedValue(blockedAccountAuthRead() as never);

    const context = (await createTRPCContext({
      req: requestAt(
        '/api/trpc/user.revokeCurrentDeviceSession,user.unregisterPushToken,user.unregisterActivityToken'
      ),
      info: {
        type: 'mutation',
        calls: [
          { path: 'user.unregisterPushToken' },
          { path: 'user.unregisterActivityToken' },
          { path: 'user.revokeCurrentDeviceSession' },
        ],
      } as never,
    })) as { user: { id: string } };

    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: true })
    );
    expect(context.user).toEqual({ id: 'user-1' });
  });

  test('refuses a batch that mixes the revocation with another call', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({
        req: requestAt('/api/trpc/user.revokeCurrentDeviceSession,user.getMe', 'mobile'),
        info: {
          calls: [{ path: 'user.revokeCurrentDeviceSession' }, { path: 'user.getMe' }],
        } as never,
      })
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });

  test('refuses a batch that mixes a token cleanup with another call', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({
        req: requestAt('/api/trpc/user.unregisterPushToken,user.getMe', 'mobile'),
        info: {
          calls: [{ path: 'user.unregisterPushToken' }, { path: 'user.getMe' }],
        } as never,
      })
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });

  test('refuses a read that names none of the cleanup procedures', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({
        req: requestAt('/api/trpc/user.getMe', 'mobile'),
        info: { calls: [{ path: 'user.getMe' }] } as never,
      })
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });

  test('refuses the account when the request carries no call path', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({ req: requestAt('/api/trpc/user.getMe', 'mobile') })
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });

  // The exemption is for self-scoped writes. A cleanup path arriving as a read
  // must not be admitted, otherwise a query added to the shared list would
  // reach a refused account through the exemption.
  test.each([['user.revokeCurrentDeviceSession'], ['user.unregisterPushToken']])(
    'refuses the account when %s arrives as a query',
    async path => {
      mockedGetUserFromAuth.mockResolvedValue(
        failedAuthResponse({
          authorizationRefused: true,
          refusalReason: 'account_blocked',
        })
      );

      const error = await caught(
        createTRPCContext({
          req: requestAt(`/api/trpc/${path}`, 'mobile'),
          info: { type: 'query', calls: [{ path }] } as never,
        })
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
      expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
        expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
      );
    }
  );

  // tRPC always resolves a kind for a real request; without one the admission
  // cannot tell a write from a read, so it must not admit.
  test('refuses the account for a cleanup whose request kind is missing', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({
        req: requestAt('/api/trpc/user.revokeCurrentDeviceSession', 'mobile'),
        info: { calls: [{ path: 'user.revokeCurrentDeviceSession' }] } as never,
      })
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });
});
