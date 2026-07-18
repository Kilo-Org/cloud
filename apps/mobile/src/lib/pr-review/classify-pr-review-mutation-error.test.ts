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
  it('classifies BAD_REQUEST as non-retryable', () => {
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
