import { describe, expect, it, vi } from 'vitest';

import {
  handleTrpcQueryError,
  isUnauthorizedTrpcError,
  setTrpcUnauthorizedHandler,
} from '@/lib/auth/trpc-unauthorized';

describe('trpc-unauthorized narrow check', () => {
  it('recognizes a context auth failure with data.authRequired (direct)', () => {
    expect(isUnauthorizedTrpcError({ data: { authRequired: true, httpStatus: 401 } })).toBe(true);
  });

  it('recognizes a context auth failure with data.authRequired (shaped)', () => {
    expect(
      isUnauthorizedTrpcError({ shape: { data: { authRequired: true, httpStatus: 401 } } })
    ).toBe(true);
  });

  it('does NOT treat a bare 401 without authRequired as a session failure', () => {
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 401 } })).toBe(false);
    expect(isUnauthorizedTrpcError({ data: { code: 'UNAUTHORIZED', httpStatus: 401 } })).toBe(
      false
    );
  });

  it('does NOT treat a 403 as a session failure', () => {
    expect(isUnauthorizedTrpcError({ data: { httpStatus: 403 } })).toBe(false);
  });

  it('does NOT treat non-errors as session failures', () => {
    expect(isUnauthorizedTrpcError(null)).toBe(false);
  });
});

describe('handleTrpcQueryError single-flight', () => {
  it('calls the handler on an auth-required error', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const unset = setTrpcUnauthorizedHandler(handler);

    await handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    expect(handler).toHaveBeenCalledTimes(1);

    unset();
  });

  it('does nothing when no handler is set', async () => {
    // Clear any handler from a previous test.
    setTrpcUnauthorizedHandler(() => undefined)();
    // Must not throw.
    await expect(
      handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } })
    ).resolves.toBeUndefined();
  });

  it('does nothing for a non-auth-required error', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const unset = setTrpcUnauthorizedHandler(handler);

    await handleTrpcQueryError({ data: { httpStatus: 401 } });
    await handleTrpcQueryError({ data: { httpStatus: 500 } });
    expect(handler).not.toHaveBeenCalled();

    unset();
  });

  it('single-flights concurrent calls to the same handler', async () => {
    const resolveRef: { current: (() => void) | undefined } = { current: undefined };
    const handlerPromise = new Promise<void>(resolve => {
      resolveRef.current = resolve;
    });
    const handler = vi.fn().mockReturnValue(handlerPromise);
    const unset = setTrpcUnauthorizedHandler(handler);

    // Start two concurrent unauthorized errors.
    const p1 = handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    const p2 = handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });

    // The handler must be invoked exactly once.
    expect(handler).toHaveBeenCalledTimes(1);

    resolveRef.current?.();
    await Promise.all([p1, p2]);

    expect(handler).toHaveBeenCalledTimes(1);
    unset();
  });

  it('allows a second call after the first handler completes', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const unset = setTrpcUnauthorizedHandler(handler);

    await handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    expect(handler).toHaveBeenCalledTimes(1);

    await handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    expect(handler).toHaveBeenCalledTimes(2);

    unset();
  });

  it('clears the in-flight promise even if the handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const unset = setTrpcUnauthorizedHandler(handler);

    await handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    expect(handler).toHaveBeenCalledTimes(1);

    // A second call must not be stuck — it must invoke the handler again.
    const handler2 = vi.fn().mockResolvedValue(undefined);
    setTrpcUnauthorizedHandler(handler2);
    await handleTrpcQueryError({ data: { authRequired: true, httpStatus: 401 } });
    expect(handler2).toHaveBeenCalledTimes(1);

    unset();
  });
});
