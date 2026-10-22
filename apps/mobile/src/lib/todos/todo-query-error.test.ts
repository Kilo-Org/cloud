// The to-do list and detail screens share one error-state decision: a denial
// shows the access-denied state and no failure that cannot succeed on a retry
// carries a Retry action.

import { describe, expect, it } from 'vitest';

import { selectTodoQueryErrorView } from './todo-query-error';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectTodoQueryErrorView', () => {
  it('maps FORBIDDEN to permission with no retry', () => {
    expect(selectTodoQueryErrorView(makeTrpcError('FORBIDDEN'))).toEqual({
      variant: 'permission',
      showRetry: false,
    });
  });

  it('maps UNAUTHORIZED to permission with no retry', () => {
    expect(selectTodoQueryErrorView(makeTrpcError('UNAUTHORIZED'))).toEqual({
      variant: 'permission',
      showRetry: false,
    });
  });

  it('maps NOT_FOUND to not-found with no retry', () => {
    expect(selectTodoQueryErrorView(makeTrpcError('NOT_FOUND'))).toEqual({
      variant: 'not-found',
      showRetry: false,
    });
  });

  it('keeps a terminal non-denial code on the server state without a retry', () => {
    expect(selectTodoQueryErrorView(makeTrpcError('BAD_REQUEST'))).toEqual({
      variant: 'server',
      showRetry: false,
    });
  });

  it('keeps a 500-class code on the server state with a retry', () => {
    expect(selectTodoQueryErrorView(makeTrpcError('INTERNAL_SERVER_ERROR'))).toEqual({
      variant: 'server',
      showRetry: true,
    });
  });

  it('keeps an error without a tRPC code retryable', () => {
    expect(selectTodoQueryErrorView(new Error('network down'))).toEqual({
      variant: 'server',
      showRetry: true,
    });
    expect(selectTodoQueryErrorView(null)).toEqual({ variant: 'server', showRetry: true });
  });
});
