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

const REQUEST = new Request('http://localhost/api/trpc/user.getMe');

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

function createContext(): Promise<unknown> {
  return createTRPCContext({ req: REQUEST });
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
  test('refuses a blocked account with FORBIDDEN and the accountBlocked cause', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(createContext());

    expect(error).toBeInstanceOf(TRPCError);
    const trpcError = error as TRPCError;
    expect(trpcError.code).toBe('FORBIDDEN');
    expect(trpcError.message).toBe('Account access is blocked');
    expect(trpcError.cause).toBeInstanceOf(AccountBlockedError);

    // What the mobile client actually reads: blocked-account data, and no
    // sign-out flag.
    const shape = trpcErrorFormatter({
      shape: {
        message: trpcError.message,
        code: -32603,
        data: { code: trpcError.code, httpStatus: 403, path: 'user.getMe', stack: '' },
      },
      error: trpcError,
    } as never);
    expect(shape.data.accountBlocked).toBe(true);
    expect(shape.data.authRequired).toBeUndefined();
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

  const DEVICE = { calls: [{ path: 'user.revokeCurrentDeviceSession' }] } as const;

  test('admits the account for its own device-session revocation', async () => {
    mockedGetUserFromAuth.mockResolvedValue(blockedAccountAuthRead() as never);

    const context = (await createTRPCContext({
      req: new Request('http://localhost/api/trpc/user.revokeCurrentDeviceSession'),
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

  test('refuses a batch that mixes the revocation with another call', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(
      createTRPCContext({
        req: new Request('http://localhost/api/trpc/user.revokeCurrentDeviceSession,user.getMe'),
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

  test('refuses the account when the request carries no call path', async () => {
    mockedGetUserFromAuth.mockResolvedValue(
      failedAuthResponse({
        authorizationRefused: true,
        refusalReason: 'account_blocked',
      })
    );

    const error = await caught(createTRPCContext({ req: REQUEST }));

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).cause).toBeInstanceOf(AccountBlockedError);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ allowRefusedAccountSelfCleanup: false })
    );
  });
});
