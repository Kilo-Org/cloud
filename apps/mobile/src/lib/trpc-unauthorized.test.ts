import { describe, expect, it, vi } from 'vitest';

import {
  handleTrpcQueryError,
  isUnauthorizedTrpcError,
  setTrpcUnauthorizedHandler,
} from './auth/trpc-unauthorized';

describe('tRPC unauthorized handling', () => {
  it('recognizes a context auth failure flagged with data.authRequired (direct + shaped)', () => {
    expect(isUnauthorizedTrpcError({ data: { authRequired: true, httpStatus: 401 } })).toBe(true);
    expect(
      isUnauthorizedTrpcError({ shape: { data: { authRequired: true, httpStatus: 401 } } })
    ).toBe(true);
  });

  it('does NOT treat a bare 401 without authRequired as a session failure', () => {
    // Regression guard: a procedure-level UNAUTHORIZED (e.g. org-access denial)
    // is also HTTP 401 but must be handled in-screen, not by signing out.
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 401 } })).toBe(false);
    expect(isUnauthorizedTrpcError({ data: { code: 'UNAUTHORIZED', httpStatus: 401 } })).toBe(
      false
    );
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 403 } })).toBe(false);
  });

  it('runs the registered sign-out handler for a context auth failure', () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);

    handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });

    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });

  it('does not run the handler for a bare 401 or other errors', () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);

    handleTrpcQueryError({ data: { httpStatus: 401 } });
    handleTrpcQueryError({ data: { httpStatus: 500 } });

    expect(signOut).not.toHaveBeenCalled();
    clear();
  });
});
