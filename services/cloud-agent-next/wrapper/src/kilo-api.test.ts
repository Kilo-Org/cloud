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

  it('matches Bun fetch connection codes', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
          code: 'ConnectionRefused',
        })
      )
    ).toBe(true);
  });

  it('matches a wrapped SDK transport failure through its cause', () => {
    const transport = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      { code: 'ConnectionRefused' }
    );
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: Unable to connect.', { cause: transport })
      )
    ).toBe(true);
  });

  it('does not match a live-server application error whose body mentions a fetch failure', () => {
    // A live kilo server relaying an upstream failure: the parsed response body
    // (a plain object, not an Error) is attached as cause by the wrapper.
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: upstream fetch failed: provider 502', {
          cause: { message: 'upstream fetch failed: provider 502' },
        })
      )
    ).toBe(false);
  });

  it('never pattern-matches the composed message of an error that carries a cause', () => {
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: fetch failed', {
          cause: new Error('application rejected the command'),
        })
      )
    ).toBe(false);
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
