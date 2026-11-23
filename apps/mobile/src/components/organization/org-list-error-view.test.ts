import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { selectOrgListErrorView } from './org-list-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectOrgListErrorView', () => {
  it('maps FORBIDDEN to permission with no retry', () => {
    expect(selectOrgListErrorView(makeTrpcError('FORBIDDEN'))).toEqual({
      variant: 'permission',
      showRetry: false,
    });
  });

  it('maps UNAUTHORIZED to permission with no retry', () => {
    expect(selectOrgListErrorView(makeTrpcError('UNAUTHORIZED'))).toEqual({
      variant: 'permission',
      showRetry: false,
    });
  });

  it('maps NOT_FOUND to not-found with no retry', () => {
    expect(selectOrgListErrorView(makeTrpcError('NOT_FOUND'))).toEqual({
      variant: 'not-found',
      showRetry: false,
    });
  });

  it.each(['BAD_REQUEST', 'CONFLICT', 'UNPROCESSABLE_CONTENT'] as const)(
    'maps %s to terminal with no retry',
    code => {
      expect(selectOrgListErrorView(makeTrpcError(code))).toEqual({
        variant: 'terminal',
        showRetry: false,
      });
    }
  );

  it('maps a 500-class code to server with retry', () => {
    expect(selectOrgListErrorView(makeTrpcError('INTERNAL_SERVER_ERROR'))).toEqual({
      variant: 'server',
      showRetry: true,
    });
  });

  it('names a deadline abort as the retryable slow-response state', () => {
    expect(selectOrgListErrorView(new RequestDeadlineError(15_000))).toEqual({
      variant: 'timeout',
      showRetry: true,
    });
  });

  it('maps an unknown non-tRPC error to server with retry', () => {
    expect(selectOrgListErrorView(new Error('network down'))).toEqual({
      variant: 'server',
      showRetry: true,
    });
    expect(selectOrgListErrorView(null)).toEqual({ variant: 'server', showRetry: true });
  });
});
