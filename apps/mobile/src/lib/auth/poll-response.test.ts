import { describe, expect, it } from 'vitest';

import { classifyPollResponse } from '@/lib/auth/poll-response';

describe('classifyPollResponse', () => {
  it('resolves on 200 (approved)', () => {
    expect(classifyPollResponse(200)).toEqual({ status: 'approved' });
  });

  it('continues polling on 202 (pending)', () => {
    expect(classifyPollResponse(202)).toEqual({ status: 'pending' });
  });

  it('treats 403 as a terminal denial', () => {
    expect(classifyPollResponse(403)).toEqual({
      status: 'denied',
      message: 'Access denied by user',
    });
  });

  it('treats 410 as a terminal expiry', () => {
    expect(classifyPollResponse(410)).toEqual({
      status: 'expired',
      message: 'Code expired',
    });
  });

  it.each([100, 301, 400, 401])(
    'treats %i as a terminal error (including 1xx/3xx this endpoint never returns)',
    httpStatus => {
      const outcome = classifyPollResponse(httpStatus);
      expect(outcome.status).toBe('error');
    }
  );

  it.each([429, 500, 503])('retries with backoff on %i', httpStatus => {
    expect(classifyPollResponse(httpStatus)).toEqual({ status: 'retry' });
  });
});
