import { describe, expect, it } from '@jest/globals';
import { isTerminalAccessError, shouldRetryFailureQuery } from './SessionFailureHistory';

function trpcLikeError(data: Record<string, unknown>): Error {
  return Object.assign(new Error('failed'), { data });
}

describe('isTerminalAccessError', () => {
  it.each([
    [{ code: 'FORBIDDEN' }],
    [{ code: 'UNAUTHORIZED' }],
    [{ code: 'NOT_FOUND' }],
    [{ httpStatus: 403 }],
    [{ httpStatus: 404 }],
  ])('treats %j as a permanent denial', data => {
    expect(isTerminalAccessError(trpcLikeError(data))).toBe(true);
  });

  it.each([null, undefined, 'boom', new Error('network'), { data: { httpStatus: 500 } }])(
    'does not treat %j as a permanent denial',
    error => {
      expect(isTerminalAccessError(error)).toBe(false);
    }
  );
});

describe('shouldRetryFailureQuery', () => {
  it('does not retry a permanent denial', () => {
    expect(shouldRetryFailureQuery(0, trpcLikeError({ code: 'FORBIDDEN' }))).toBe(false);
    expect(shouldRetryFailureQuery(0, trpcLikeError({ httpStatus: 403 }))).toBe(false);
  });

  it('does not retry other 4xx answers', () => {
    expect(
      shouldRetryFailureQuery(0, trpcLikeError({ code: 'BAD_REQUEST', httpStatus: 400 }))
    ).toBe(false);
  });

  it('retries transport failures and 5xx answers within the bound', () => {
    expect(shouldRetryFailureQuery(0, new Error('network'))).toBe(true);
    expect(shouldRetryFailureQuery(1, trpcLikeError({ httpStatus: 503 }))).toBe(true);
    expect(shouldRetryFailureQuery(2, trpcLikeError({ httpStatus: 503 }))).toBe(false);
    expect(shouldRetryFailureQuery(2, new Error('network'))).toBe(false);
  });
});
