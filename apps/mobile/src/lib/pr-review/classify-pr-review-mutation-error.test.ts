import { describe, expect, it } from 'vitest';

import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';

function makeTrpcError(code: string, message?: string): unknown {
  return { data: { code, ...(message ? { message } : {}) } };
}

function makeNestedTrpcError(code: string): unknown {
  return { shape: { data: { code } } };
}

function makeTopLevelTrpcError(code: string): unknown {
  return { code };
}

describe('classifyPrReviewMutationError', () => {
  it('classifies BAD_REQUEST as non-retryable bad-request', () => {
    const error = new Error('Cannot approve your own pull request');
    Object.assign(error, { data: { code: 'BAD_REQUEST' } });
    expect(classifyPrReviewMutationError(error)).toEqual({
      kind: 'bad-request',
      message: 'Cannot approve your own pull request',
    });
  });

  it('classifies BAD_REQUEST from the nested shape too', () => {
    expect(classifyPrReviewMutationError(makeNestedTrpcError('BAD_REQUEST'))).toEqual({
      kind: 'bad-request',
      message: 'Bad request',
    });
  });

  it('classifies BAD_REQUEST from a top-level code field', () => {
    expect(classifyPrReviewMutationError(makeTopLevelTrpcError('BAD_REQUEST'))).toEqual({
      kind: 'bad-request',
      message: 'Bad request',
    });
  });

  it('classifies FORBIDDEN as terminal forbidden', () => {
    const error = new Error('Resource not accessible by integration');
    Object.assign(error, { data: { code: 'FORBIDDEN' } });
    expect(classifyPrReviewMutationError(error)).toEqual({
      kind: 'forbidden',
      message: 'Resource not accessible by integration',
    });
  });

  it('classifies FORBIDDEN from a top-level code field', () => {
    expect(classifyPrReviewMutationError(makeTopLevelTrpcError('FORBIDDEN'))).toEqual({
      kind: 'forbidden',
      message: 'Forbidden',
    });
  });

  it('classifies PRECONDITION_FAILED as reconnect', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('PRECONDITION_FAILED'))).toEqual({
      kind: 'reconnect',
      message: 'GitHub connection expired',
    });
  });

  it('classifies UNAUTHORIZED as reconnect', () => {
    const error = new Error('Bad credentials');
    Object.assign(error, { data: { code: 'UNAUTHORIZED' } });
    expect(classifyPrReviewMutationError(error)).toEqual({
      kind: 'reconnect',
      message: 'Bad credentials',
    });
  });

  it('classifies TOO_MANY_REQUESTS as retryable', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('TOO_MANY_REQUESTS'))).toEqual({
      kind: 'retryable',
    });
  });

  it('classifies network errors as retryable', () => {
    expect(classifyPrReviewMutationError(new Error('Network request failed'))).toEqual({
      kind: 'retryable',
    });
  });

  it('classifies 5xx tRPC errors as retryable', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('INTERNAL_SERVER_ERROR'))).toEqual({
      kind: 'retryable',
    });
    expect(classifyPrReviewMutationError(makeTrpcError('TIMEOUT'))).toEqual({
      kind: 'retryable',
    });
  });

  it('classifies unknown / malformed errors as retryable', () => {
    expect(classifyPrReviewMutationError('string error')).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewMutationError(null)).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewMutationError(undefined)).toEqual({ kind: 'retryable' });
  });
});
