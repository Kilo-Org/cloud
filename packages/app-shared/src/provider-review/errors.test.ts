import { describe, expect, it } from 'vitest';

import { isNetworkFailure, ProviderApiStatusError, ProviderReviewError } from './errors';

describe('ProviderReviewError', () => {
  it('derives retryable only from the retryable kind', () => {
    expect(new ProviderReviewError('retryable', 'later').retryable).toBe(true);
    for (const kind of ['not_found', 'forbidden', 'stale_head', 'bad_request'] as const) {
      expect(new ProviderReviewError(kind, 'no').retryable).toBe(false);
    }
  });

  it('carries the kind and message', () => {
    const error = new ProviderReviewError('stale_head', 'moved');
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('stale_head');
    expect(error.message).toBe('moved');
  });
});

describe('ProviderApiStatusError', () => {
  it('carries the HTTP status', () => {
    const error = new ProviderApiStatusError(404, 'missing');
    expect(error.status).toBe(404);
    expect(error.message).toBe('missing');
  });
});

describe('isNetworkFailure', () => {
  it('detects fetch, timeout, and abort failures', () => {
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkFailure(new Error('request failed: fetch failed'))).toBe(true);
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isNetworkFailure(timeout)).toBe(true);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isNetworkFailure(abort)).toBe(true);
  });

  it('does not classify ordinary errors as network failures', () => {
    expect(isNetworkFailure(new Error('not found'))).toBe(false);
  });
});
