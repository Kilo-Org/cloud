import { describe, expect, it, vi } from 'vitest';

import {
  handleTrpcQueryError,
  isUnauthorizedTrpcError,
  setTrpcUnauthorizedHandler,
} from './auth/trpc-unauthorized';

describe('tRPC unauthorized handling', () => {
  it('recognizes tRPC query errors with HTTP 401 status', () => {
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 401 } })).toBe(true);
    expect(isUnauthorizedTrpcError({ shape: { data: { httpStatus: 401 } } })).toBe(true);
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 403 } })).toBe(false);
  });

  it('runs the registered sign-out handler for a 401 query error', () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);

    handleTrpcQueryError({ data: { httpStatus: 401 } });

    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });

  it('does not run the handler for non-401 query errors', () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);

    handleTrpcQueryError({ data: { httpStatus: 500 } });

    expect(signOut).not.toHaveBeenCalled();
    clear();
  });
});
