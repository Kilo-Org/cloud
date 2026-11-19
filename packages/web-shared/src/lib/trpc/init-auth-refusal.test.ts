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
