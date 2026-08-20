// Pure tests for the PR operation ledger mobile helpers (P1-A-08c).
//
// This suite covers the error classification, the ledger-outcome →
// display-copy mapping, and the toast message selection without any React.
// `useHoistedOperationKey` is React state (useRef) and lives in
// `@/lib/operation-key`, covered by `operation-key.mounted.test.tsx`.

import { describe, expect, it, vi } from 'vitest';

import { OPERATION_IN_PROGRESS_MESSAGE } from '@/lib/operation-key';
import {
  isPrMutationRetryable,
  isPrOperationPersistenceFailed,
  mapPrOperationError,
  PR_OPERATION_AMBIGUOUS_MESSAGE,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

// `@/lib/operation-key` imports expo-crypto for the hoisted key, which drags
// react-native in and does not parse under the pure project.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used-in-pure-tests',
}));

const IN_PROGRESS = new Error(OPERATION_IN_PROGRESS_MESSAGE);
const AMBIGUOUS = new Error(PR_OPERATION_AMBIGUOUS_MESSAGE);
const PERSISTENCE_FAILED = new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);

function trpcError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code, message } });
  return error;
}

describe('isPrOperationPersistenceFailed', () => {
  it('detects the persistence-failure marker distinctly from the other markers', () => {
    expect(isPrOperationPersistenceFailed(PERSISTENCE_FAILED)).toBe(true);
    expect(isPrOperationPersistenceFailed(AMBIGUOUS)).toBe(false);
    expect(isPrOperationPersistenceFailed(IN_PROGRESS)).toBe(false);
    expect(isPrOperationPersistenceFailed('string error')).toBe(false);
  });
});

describe('mapPrOperationError', () => {
  it.each([
    ['create-comment', 'Could not post comment.'],
    ['submit-review', 'Could not submit review. Check your connection and try again.'],
    ['reply', 'Could not reply.'],
    ['merge', 'Could not merge pull request.'],
  ] as const)(
    'maps operation_in_progress onto the existing %s retryable copy',
    (surface, expected) => {
      const mapped = mapPrOperationError(IN_PROGRESS, surface);
      expect(mapped).toBeInstanceOf(Error);
      expect(mapped.message).toBe(expected);
    }
  );

  it.each(['create-comment', 'submit-review', 'reply', 'merge'] as const)(
    'maps the ambiguous outcome onto the verify-before-retrying copy for %s',
    surface => {
      const mapped = mapPrOperationError(AMBIGUOUS, surface);
      expect(mapped).toBeInstanceOf(Error);
      expect(mapped.message).toBe(PR_OPERATION_AMBIGUOUS_MESSAGE);
    }
  );

  it.each(['create-comment', 'submit-review', 'reply', 'merge'] as const)(
    'maps the persistence-failure marker onto the terminal could-not-record copy for %s',
    surface => {
      const mapped = mapPrOperationError(PERSISTENCE_FAILED, surface);
      expect(mapped).toBeInstanceOf(Error);
      expect(mapped.message).toBe(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
    }
  );

  it('passes every other error through unchanged (same identity)', () => {
    const original = trpcError('BAD_REQUEST', 'Cannot approve your own pull request');
    expect(mapPrOperationError(original, 'submit-review')).toBe(original);
    const retryable = new Error('Network request failed');
    expect(mapPrOperationError(retryable, 'create-comment')).toBe(retryable);
  });
});

describe('prOperationToastMessage', () => {
  it('returns the mapped surface copy for an in-progress marker', () => {
    expect(prOperationToastMessage(IN_PROGRESS, 'merge')).toBe('Could not merge pull request.');
  });

  it('returns the ambiguous copy for the ambiguous marker', () => {
    expect(prOperationToastMessage(AMBIGUOUS, 'reply')).toBe(PR_OPERATION_AMBIGUOUS_MESSAGE);
  });

  it('returns the terminal could-not-record copy for the persistence-failure marker', () => {
    expect(prOperationToastMessage(PERSISTENCE_FAILED, 'merge')).toBe(
      PR_OPERATION_PERSISTENCE_FAILED_MESSAGE
    );
  });

  it('returns the underlying message for a passthrough error', () => {
    expect(prOperationToastMessage(new Error('boom'), 'merge')).toBe('boom');
  });

  it('returns a fallback for non-Error values', () => {
    expect(prOperationToastMessage('not an error', 'merge')).toBe(
      'Could not complete this action.'
    );
  });
});

describe('isPrMutationRetryable (operation-key rotation policy)', () => {
  it('keeps the key on retryable ledger outcomes (in-progress, ambiguous)', () => {
    expect(isPrMutationRetryable(IN_PROGRESS)).toBe(true);
    expect(isPrMutationRetryable(AMBIGUOUS)).toBe(true);
  });

  it('keeps the key on network / 5xx / rate-limit retryable failures', () => {
    expect(isPrMutationRetryable(new Error('Network request failed'))).toBe(true);
    expect(isPrMutationRetryable(trpcError('INTERNAL_SERVER_ERROR', 'boom'))).toBe(true);
    expect(isPrMutationRetryable(trpcError('TIMEOUT', 'timeout'))).toBe(true);
    expect(isPrMutationRetryable(trpcError('TOO_MANY_REQUESTS', 'slow down'))).toBe(true);
  });

  it('regenerates the key on non-retryable failures (bad-request, forbidden, reconnect)', () => {
    expect(
      isPrMutationRetryable(trpcError('BAD_REQUEST', 'Cannot approve your own pull request'))
    ).toBe(false);
    expect(isPrMutationRetryable(trpcError('FORBIDDEN', 'no permission'))).toBe(false);
    expect(isPrMutationRetryable(trpcError('PRECONDITION_FAILED', 'reconnect'))).toBe(false);
    expect(isPrMutationRetryable(trpcError('UNAUTHORIZED', 'bad credentials'))).toBe(false);
  });

  it('regenerates the key on the persistence-failure marker even though it is INTERNAL_SERVER_ERROR', () => {
    // The server signals reconcile-pending persistence failure with an
    // INTERNAL_SERVER_ERROR marker. It must NOT be treated as a generic
    // retryable failure: the same key was never marked reconcile-pending, so a
    // same-key retry could re-execute a possibly-committed write.
    const persistenceError = trpcError(
      'INTERNAL_SERVER_ERROR',
      PR_OPERATION_PERSISTENCE_FAILED_MESSAGE
    );
    expect(isPrMutationRetryable(persistenceError)).toBe(false);
  });
});
