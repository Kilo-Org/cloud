import { describe, expect, it } from 'vitest';

import {
  classifyPrReviewMutationError,
  classifyPrReviewQueryState,
} from './classify-pr-review-query-state';

function makeTrpcError(code: string): unknown {
  // Mirrors the shape tRPC v11 surfaces on a thrown TRPCClientError from
  // a query: `data.code` is the canonical TRPC_ERROR_CODE_KEY.
  return { data: { code } };
}

function makeNestedTrpcError(code: string): unknown {
  // Some helpers wrap the shape under `shape.data.code`. The classifier
  // must accept both forms so a future tRPC upgrade can't silently
  // route every error to the retryable branch.
  return { shape: { data: { code } } };
}

function makeTopLevelTrpcError(code: string): unknown {
  return { code };
}

describe('classifyPrReviewQueryState', () => {
  it('classifies PRECONDITION_FAILED as a reconnect state (no retry, reconnect CTA)', () => {
    expect(classifyPrReviewQueryState(makeTrpcError('PRECONDITION_FAILED'))).toEqual({
      kind: 'reconnect',
    });
  });

  it('classifies NOT_FOUND as a not-found empty state (no retry, install-CTA only)', () => {
    expect(classifyPrReviewQueryState(makeTrpcError('NOT_FOUND'))).toEqual({
      kind: 'not-found',
    });
  });

  it('classifies FORBIDDEN as a permanent permission error (no CTA, no retry)', () => {
    expect(classifyPrReviewQueryState(makeTrpcError('FORBIDDEN'))).toEqual({
      kind: 'permission',
    });
  });

  it('classifies UNAUTHORIZED as a reconnect state (revoked connection, reconnect CTA)', () => {
    expect(classifyPrReviewQueryState(makeTrpcError('UNAUTHORIZED'))).toEqual({
      kind: 'reconnect',
    });
  });

  it('reads the code from the nested shape.data.code form too', () => {
    expect(classifyPrReviewQueryState(makeNestedTrpcError('NOT_FOUND'))).toEqual({
      kind: 'not-found',
    });
    expect(classifyPrReviewQueryState(makeNestedTrpcError('PRECONDITION_FAILED'))).toEqual({
      kind: 'reconnect',
    });
  });

  it('reads the code from a top-level `code` field', () => {
    expect(classifyPrReviewQueryState(makeTopLevelTrpcError('FORBIDDEN'))).toEqual({
      kind: 'permission',
    });
  });

  it('falls back to retryable for unknown / non-tRPC errors', () => {
    expect(classifyPrReviewQueryState(new Error('network down'))).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewQueryState('string error')).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewQueryState(null)).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewQueryState(undefined)).toEqual({ kind: 'retryable' });
  });

  it('falls back to retryable for tRPC 5xx-class codes', () => {
    expect(classifyPrReviewQueryState(makeTrpcError('INTERNAL_SERVER_ERROR'))).toEqual({
      kind: 'retryable',
    });
    expect(classifyPrReviewQueryState(makeTrpcError('TIMEOUT'))).toEqual({ kind: 'retryable' });
  });
});

describe('classifyPrReviewMutationError', () => {
  it('classifies FORBIDDEN as a terminal permission error', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('FORBIDDEN'))).toEqual({
      kind: 'forbidden',
      message: 'Forbidden',
    });
  });

  it('classifies UNAUTHORIZED as a reconnect state', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('UNAUTHORIZED'))).toEqual({
      kind: 'reconnect',
      message: 'GitHub connection expired',
    });
  });

  it('classifies PRECONDITION_FAILED as a reconnect state', () => {
    expect(classifyPrReviewMutationError(makeTrpcError('PRECONDITION_FAILED'))).toEqual({
      kind: 'reconnect',
      message: 'GitHub connection expired',
    });
  });

  it('falls back to retryable for unknown / non-tRPC errors', () => {
    expect(classifyPrReviewMutationError(new Error('network down'))).toEqual({ kind: 'retryable' });
    expect(classifyPrReviewMutationError('string error')).toEqual({ kind: 'retryable' });
  });
});
