import { CONTROL_PLANE_TIMEOUT_MESSAGE } from '@kilocode/app-shared/control-plane';
import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { isControlPlaneTimeout, trpcErrorVariant } from '@/lib/trpc-error';

/** The shape the tRPC client rejects with once it has a server answer. */
function trpcCode(code: string): unknown {
  return { data: { code } };
}

/** The answer the server's procedure budget settles a mobile call with. */
function budgetTimeout(): unknown {
  return {
    data: {
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      message: CONTROL_PLANE_TIMEOUT_MESSAGE,
    },
  };
}

describe('isControlPlaneTimeout', () => {
  it('recognizes the budget message on a tRPC client error', () => {
    // The production shape: the client keeps the code under data and the
    // server's message as the error's own message.
    const error = Object.assign(new Error(CONTROL_PLANE_TIMEOUT_MESSAGE), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'agentProfiles.list' },
    });
    expect(isControlPlaneTimeout(error)).toBe(true);
    expect(trpcErrorVariant(error)).toBe('timeout');
  });

  it('recognizes a bare answer whose message sits under data', () => {
    expect(isControlPlaneTimeout(budgetTimeout())).toBe(true);
  });

  it('recognizes the client deadline error itself', () => {
    expect(isControlPlaneTimeout(new RequestDeadlineError(15_000))).toBe(true);
  });

  it('unwraps the tRPC client error that carries the deadline as its cause', () => {
    const wrapped = Object.assign(new Error('Request timed out after 15000ms'), {
      cause: new RequestDeadlineError(15_000),
    });
    expect(isControlPlaneTimeout(wrapped)).toBe(true);
  });

  it('walks a nested cause chain', () => {
    const nested = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('inner'), { cause: new RequestDeadlineError(15_000) }),
    });
    expect(isControlPlaneTimeout(nested)).toBe(true);
  });

  it('is false for a server answer, an unknown failure, and no error at all', () => {
    expect(isControlPlaneTimeout(trpcCode('INTERNAL_SERVER_ERROR'))).toBe(false);
    expect(isControlPlaneTimeout(new Error('network down'))).toBe(false);
    expect(isControlPlaneTimeout(undefined)).toBe(false);
    expect(isControlPlaneTimeout(null)).toBe(false);
  });
});

describe('trpcErrorVariant', () => {
  it('names a server budget answer as the retryable slow-response state', () => {
    expect(trpcErrorVariant(budgetTimeout())).toBe('timeout');
  });

  it('names a client deadline abort as the retryable slow-response state', () => {
    expect(trpcErrorVariant(new RequestDeadlineError(15_000))).toBe('timeout');
    expect(
      trpcErrorVariant(
        Object.assign(new Error('aborted'), { cause: new RequestDeadlineError(15_000) })
      )
    ).toBe('timeout');
  });

  it('keeps the code mapping for a server answer', () => {
    expect(trpcErrorVariant(trpcCode('FORBIDDEN'))).toBe('permission');
    expect(trpcErrorVariant(trpcCode('UNAUTHORIZED'))).toBe('permission');
    expect(trpcErrorVariant(trpcCode('NOT_FOUND'))).toBe('not-found');
    expect(trpcErrorVariant(trpcCode('INTERNAL_SERVER_ERROR'))).toBe('server');
    expect(trpcErrorVariant(trpcCode('BAD_REQUEST'))).toBe('server');
  });

  it('falls back to the server state for a failure it cannot explain', () => {
    expect(trpcErrorVariant(new Error('network down'))).toBe('server');
    expect(trpcErrorVariant(undefined)).toBe('server');
    expect(trpcErrorVariant(null)).toBe('server');
  });
});
