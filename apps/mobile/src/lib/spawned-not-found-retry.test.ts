import { describe, expect, it } from 'vitest';

import {
  shouldRetryNotFoundOnSpawnedRoute,
  SPAWNED_NOT_FOUND_MAX_ATTEMPTS,
} from './spawned-not-found-retry';

describe('shouldRetryNotFoundOnSpawnedRoute', () => {
  describe('spawned param absent (regression: byte-identical to pre-C3b behavior)', () => {
    it('never retries on NOT_FOUND when spawned is undefined', () => {
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: undefined,
          attempt: 0,
          errorCode: 'NOT_FOUND',
        })
      ).toBe(false);
    });

    it('never retries on a non-NOT_FOUND error when spawned is undefined', () => {
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: undefined,
          attempt: 0,
          errorCode: 'INTERNAL_SERVER_ERROR',
        })
      ).toBe(false);
    });

    it('never retries even after multiple attempts when spawned is undefined', () => {
      // Belt-and-braces: a deeply-attempted absent-spawned retry must
      // still be false, so the route's existing `retry: false` contract
      // holds byte-for-byte.
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: undefined,
          attempt: 99,
          errorCode: 'NOT_FOUND',
        })
      ).toBe(false);
    });
  });

  describe('spawned param present', () => {
    it('retries NOT_FOUND on the first attempt', () => {
      expect(
        shouldRetryNotFoundOnSpawnedRoute({ spawned: '1', attempt: 0, errorCode: 'NOT_FOUND' })
      ).toBe(true);
    });

    it('retries NOT_FOUND while attempt is below the ceiling', () => {
      // 0-indexed: attempt N is the (N+1)-th failure. We retry attempts
      // 0..(MAX-1) inclusive; MAX is the first attempt that does NOT
      // retry (8 tries have already happened by then).
      for (let attempt = 0; attempt < SPAWNED_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
        expect(
          shouldRetryNotFoundOnSpawnedRoute({ spawned: '1', attempt, errorCode: 'NOT_FOUND' })
        ).toBe(true);
      }
    });

    it('stops retrying once the attempt count reaches the ceiling', () => {
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: '1',
          attempt: SPAWNED_NOT_FOUND_MAX_ATTEMPTS,
          errorCode: 'NOT_FOUND',
        })
      ).toBe(false);
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: '1',
          attempt: SPAWNED_NOT_FOUND_MAX_ATTEMPTS + 5,
          errorCode: 'NOT_FOUND',
        })
      ).toBe(false);
    });

    it('does not apply spawned-retry logic to a non-NOT_FOUND error', () => {
      // The route's QueryError UI handles non-NOT_FOUND errors with
      // its own Retry CTA. Our retry must not ALSO retry those — that
      // would either double-fire or change today's behavior.
      expect(
        shouldRetryNotFoundOnSpawnedRoute({
          spawned: '1',
          attempt: 0,
          errorCode: 'INTERNAL_SERVER_ERROR',
        })
      ).toBe(false);
      expect(
        shouldRetryNotFoundOnSpawnedRoute({ spawned: '1', attempt: 0, errorCode: undefined })
      ).toBe(false);
    });

    it('treats any non-undefined spawned value (e.g. "0", "true") the same as "1"', () => {
      // The route only appends the literal "1" today, but the predicate
      // is presence-based: we only care that the spawn-path navigation
      // produced SOME value here, not its specific shape.
      expect(
        shouldRetryNotFoundOnSpawnedRoute({ spawned: '0', attempt: 0, errorCode: 'NOT_FOUND' })
      ).toBe(true);
      expect(
        shouldRetryNotFoundOnSpawnedRoute({ spawned: 'true', attempt: 0, errorCode: 'NOT_FOUND' })
      ).toBe(true);
    });
  });
});
