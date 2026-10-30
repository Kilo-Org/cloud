import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { selectProfilesListErrorView } from './profiles-list-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectProfilesListErrorView', () => {
  it.each(['UNAUTHORIZED', 'FORBIDDEN'])(
    'names %s as a permission state and offers no retry',
    code => {
      expect(
        selectProfilesListErrorView({ error: makeTrpcError(code), connectivity: 'online' })
      ).toEqual({ variant: 'permission', showRetry: false, titleKey: null });
    }
  );

  it('names NOT_FOUND as missing and offers no retry', () => {
    expect(
      selectProfilesListErrorView({ error: makeTrpcError('NOT_FOUND'), connectivity: 'unknown' })
    ).toEqual({ variant: 'not-found', showRetry: false, titleKey: null });
  });

  it('keeps a server fault retryable and titled as a load failure', () => {
    for (const error of [makeTrpcError('INTERNAL_SERVER_ERROR'), new Error('boom'), undefined]) {
      expect(selectProfilesListErrorView({ error, connectivity: 'unknown' })).toEqual({
        variant: 'server',
        showRetry: true,
        titleKey: 'profiles.loadFailed',
      });
    }
  });

  it('names a deadline abort as a retryable slow response under the list title', () => {
    expect(
      selectProfilesListErrorView({
        error: new RequestDeadlineError(15_000),
        connectivity: 'online',
      })
    ).toEqual({ variant: 'timeout', showRetry: true, titleKey: null });
    expect(
      selectProfilesListErrorView({
        error: Object.assign(new Error('aborted'), {
          cause: new RequestDeadlineError(15_000),
        }),
        connectivity: 'unknown',
      })
    ).toEqual({ variant: 'timeout', showRetry: true, titleKey: null });
  });

  it('treats a confirmed-offline device as connectivity even for a terminal code', () => {
    expect(
      selectProfilesListErrorView({
        error: makeTrpcError('UNAUTHORIZED'),
        connectivity: 'offline',
      })
    ).toEqual({ variant: 'offline', showRetry: true, titleKey: 'profiles.loadFailed' });
  });
});
