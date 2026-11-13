import { describe, expect, it } from 'vitest';

import {
  shouldRetrySessionNotFound,
  SPAWNED_NOT_FOUND_MAX_ATTEMPTS,
} from './spawned-not-found-retry';

describe('shouldRetrySessionNotFound', () => {
  it('retries NOT_FOUND on the first attempt', () => {
    expect(shouldRetrySessionNotFound({ attempt: 0, errorCode: 'NOT_FOUND' })).toBe(true);
  });

  it('retries NOT_FOUND while attempt is below the ceiling', () => {
    for (let attempt = 0; attempt < SPAWNED_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
      expect(shouldRetrySessionNotFound({ attempt, errorCode: 'NOT_FOUND' })).toBe(true);
    }
  });

  it('stops retrying once the attempt count reaches the ceiling', () => {
    expect(
      shouldRetrySessionNotFound({
        attempt: SPAWNED_NOT_FOUND_MAX_ATTEMPTS,
        errorCode: 'NOT_FOUND',
      })
    ).toBe(false);
    expect(
      shouldRetrySessionNotFound({
        attempt: SPAWNED_NOT_FOUND_MAX_ATTEMPTS + 5,
        errorCode: 'NOT_FOUND',
      })
    ).toBe(false);
  });

  it('never retries an access denial, so the account boundary stays immediate', () => {
    // The restored-identity open used to be denied the budget to keep this
    // boundary quick; the boundary is these codes, and they are never repeated
    // for any open.
    for (const errorCode of ['UNAUTHORIZED', 'FORBIDDEN']) {
      for (let attempt = 0; attempt <= SPAWNED_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
        expect(shouldRetrySessionNotFound({ attempt, errorCode })).toBe(false);
      }
    }
  });

  it('does not retry another failure code or a missing one', () => {
    expect(shouldRetrySessionNotFound({ attempt: 0, errorCode: 'INTERNAL_SERVER_ERROR' })).toBe(
      false
    );
    expect(shouldRetrySessionNotFound({ attempt: 0, errorCode: undefined })).toBe(false);
  });
});
