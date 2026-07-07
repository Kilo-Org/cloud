import { describe, expect, it } from 'bun:test';
import { isKiloServerUnreachableError } from './kilo-api';

describe('isKiloServerUnreachableError', () => {
  it('matches a raw ECONNREFUSED error', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5173'), {
      code: 'ECONNREFUSED',
    });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches a fetch TypeError whose cause carries the network error code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const error = new Error('fetch failed', { cause });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches common Bun/undici connection-refused message text without a code', () => {
    expect(
      isKiloServerUnreachableError(new Error('Unable to connect. Is the server running?'))
    ).toBe(true);
    expect(isKiloServerUnreachableError(new Error('fetch failed'))).toBe(true);
  });

  it('matches ECONNRESET and EPIPE', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      )
    ).toBe(true);
    expect(
      isKiloServerUnreachableError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).toBe(true);
  });

  it('does not match application-level errors from a live server', () => {
    expect(
      isKiloServerUnreachableError(new Error('Session get returned no data for ses_123'))
    ).toBe(false);
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: invalid model')
      )
    ).toBe(false);
  });

  it('does not match non-Error values', () => {
    expect(isKiloServerUnreachableError('ECONNREFUSED')).toBe(false);
    expect(isKiloServerUnreachableError(undefined)).toBe(false);
    expect(isKiloServerUnreachableError(null)).toBe(false);
  });
});
