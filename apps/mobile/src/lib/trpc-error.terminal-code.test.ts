import { describe, expect, it } from 'vitest';

import { isRetryableTrpcError, isTerminalTrpcCode } from '@/lib/trpc-error';

// The terminal-code reader and the retry decision built on it: a code that
// names a state already settled stays settled on a retry, and a conflict keeps
// that verdict in either envelope shape. The rest of `trpc-error` lives in
// `trpc-error.test.ts`; this suite sits apart so both files stay under the
// mobile lint's line cap.

describe('isTerminalTrpcCode', () => {
  it.each(['CONFLICT', 'BAD_REQUEST', 'NOT_FOUND'])('is terminal for %s', code => {
    expect(isTerminalTrpcCode(code)).toBe(true);
  });

  it.each(['TOO_MANY_REQUESTS', 'PRECONDITION_FAILED', 'INTERNAL_SERVER_ERROR'])(
    'stays retryable for %s',
    code => {
      expect(isTerminalTrpcCode(code)).toBe(false);
    }
  );

  it('stays retryable for a failure with no code', () => {
    expect(isTerminalTrpcCode(undefined)).toBe(false);
  });

  it('offers no retry for a conflict in either envelope shape', () => {
    // A conflict names a state that already exists, so the same request repeats
    // the same refusal.
    const direct = Object.assign(new Error('Trigger Name "take-one" already exists'), {
      name: 'TRPCClientError',
      data: { code: 'CONFLICT' },
    });
    expect(isRetryableTrpcError(direct)).toBe(false);
    expect(isRetryableTrpcError({ shape: { data: { code: 'CONFLICT' } } })).toBe(false);
  });
});
