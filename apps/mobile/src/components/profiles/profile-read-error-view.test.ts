import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { selectProfileReadErrorView } from './profile-read-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectProfileReadErrorView', () => {
  it.each(['UNAUTHORIZED', 'FORBIDDEN'])(
    'names %s as a permission state and offers no retry',
    code => {
      expect(
        selectProfileReadErrorView({ error: makeTrpcError(code), connectivity: 'online' })
      ).toEqual({ variant: 'permission', showRetry: false, titleKey: null });
    }
  );

  it('names NOT_FOUND as missing and offers no retry', () => {
    expect(
      selectProfileReadErrorView({ error: makeTrpcError('NOT_FOUND'), connectivity: 'unknown' })
    ).toEqual({ variant: 'not-found', showRetry: false, titleKey: null });
  });

  it('names a terminal refusal that is not an access outcome as missing', () => {
    for (const code of ['BAD_REQUEST', 'UNPROCESSABLE_CONTENT']) {
      expect(
        selectProfileReadErrorView({ error: makeTrpcError(code), connectivity: 'unknown' })
      ).toEqual({ variant: 'not-found', showRetry: false, titleKey: null });
    }
  });

  it('keeps a server fault retryable and titled as a load failure', () => {
    for (const error of [makeTrpcError('INTERNAL_SERVER_ERROR'), new Error('boom'), undefined]) {
      expect(selectProfileReadErrorView({ error, connectivity: 'unknown' })).toEqual({
        variant: 'server',
        showRetry: true,
        titleKey: 'profiles.loadFailed',
      });
    }
  });

  it('names a deadline abort as a retryable slow response under the list title', () => {
    expect(
      selectProfileReadErrorView({
        error: new RequestDeadlineError(15_000),
        connectivity: 'online',
      })
    ).toEqual({ variant: 'timeout', showRetry: true, titleKey: null });
    expect(
      selectProfileReadErrorView({
        error: Object.assign(new Error('aborted'), {
          cause: new RequestDeadlineError(15_000),
        }),
        connectivity: 'unknown',
      })
    ).toEqual({ variant: 'timeout', showRetry: true, titleKey: null });
  });

  it('keeps a non-tRPC error with a bare terminal code retryable', () => {
    expect(
      selectProfileReadErrorView({ error: { code: 'FORBIDDEN' }, connectivity: 'online' })
    ).toEqual({ variant: 'permission', showRetry: true, titleKey: null });
  });

  it('treats a confirmed-offline device as connectivity even for a terminal code', () => {
    expect(
      selectProfileReadErrorView({
        error: makeTrpcError('UNAUTHORIZED'),
        connectivity: 'offline',
      })
    ).toEqual({ variant: 'offline', showRetry: true, titleKey: 'profiles.loadFailed' });
  });
});
