import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { pickReadError, selectProfileReadErrorView } from './profile-read-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

describe('selectProfileReadErrorView', () => {
  it.each(['UNAUTHORIZED', 'FORBIDDEN'])(
    'names %s as a permission state and offers no retry',
    code => {
      expect(
        selectProfileReadErrorView({ error: makeTrpcError(code), connectivity: 'online' })
      ).toEqual({
        variant: 'permission',
        showRetry: false,
        titleKey: null,
        descriptionKey: 'organization.boundary.accessDeniedDescription',
      });
    }
  );

  it('names a refused session credential as a permission state without the boundary line', () => {
    // `data.authRequired` is the context-level flag: the server refused the
    // request's session credential, which the auth layer ends itself. Nobody
    // owns a grant here, so the boundary description would point at an owner
    // who does not exist; the variant's own permission copy stands.
    expect(
      selectProfileReadErrorView({
        error: { data: { code: 'UNAUTHORIZED', authRequired: true } },
        connectivity: 'online',
      })
    ).toEqual({
      variant: 'permission',
      showRetry: false,
      titleKey: null,
      descriptionKey: null,
    });
  });

  it('names NOT_FOUND as missing and offers no retry', () => {
    expect(
      selectProfileReadErrorView({ error: makeTrpcError('NOT_FOUND'), connectivity: 'unknown' })
    ).toEqual({
      variant: 'not-found',
      showRetry: false,
      titleKey: null,
      descriptionKey: null,
    });
  });

  it('names a terminal refusal that is not an access outcome as missing', () => {
    for (const code of ['BAD_REQUEST', 'UNPROCESSABLE_CONTENT']) {
      expect(
        selectProfileReadErrorView({ error: makeTrpcError(code), connectivity: 'unknown' })
      ).toEqual({
        variant: 'not-found',
        showRetry: false,
        titleKey: null,
        descriptionKey: null,
      });
    }
  });

  it('keeps a server fault retryable and titled as a load failure', () => {
    for (const error of [makeTrpcError('INTERNAL_SERVER_ERROR'), new Error('boom'), undefined]) {
      expect(selectProfileReadErrorView({ error, connectivity: 'unknown' })).toEqual({
        variant: 'server',
        showRetry: true,
        titleKey: 'profiles.loadFailed',
        descriptionKey: null,
      });
    }
  });

  it('names a deadline abort as a retryable slow response under the list title', () => {
    expect(
      selectProfileReadErrorView({
        error: new RequestDeadlineError(15_000),
        connectivity: 'online',
      })
    ).toEqual({
      variant: 'timeout',
      showRetry: true,
      titleKey: null,
      descriptionKey: null,
    });
    expect(
      selectProfileReadErrorView({
        error: Object.assign(new Error('aborted'), {
          cause: new RequestDeadlineError(15_000),
        }),
        connectivity: 'unknown',
      })
    ).toEqual({
      variant: 'timeout',
      showRetry: true,
      titleKey: null,
      descriptionKey: null,
    });
  });

  it('keeps a non-tRPC error with a bare terminal code retryable under the server copy', () => {
    for (const error of [{ code: 'FORBIDDEN' }, { code: 'NOT_FOUND' }, { code: 'BAD_REQUEST' }]) {
      expect(selectProfileReadErrorView({ error, connectivity: 'online' })).toEqual({
        variant: 'server',
        showRetry: true,
        titleKey: 'profiles.loadFailed',
        descriptionKey: null,
      });
    }
  });

  it('keeps a coded refusal when the device reports offline: the server answered', () => {
    expect(
      selectProfileReadErrorView({
        error: makeTrpcError('UNAUTHORIZED'),
        connectivity: 'offline',
      })
    ).toEqual({
      variant: 'permission',
      showRetry: false,
      titleKey: null,
      descriptionKey: 'organization.boundary.accessDeniedDescription',
    });
  });

  it('keeps NOT_FOUND when the device reports offline: the server answered', () => {
    expect(
      selectProfileReadErrorView({ error: makeTrpcError('NOT_FOUND'), connectivity: 'offline' })
    ).toEqual({
      variant: 'not-found',
      showRetry: false,
      titleKey: null,
      descriptionKey: null,
    });
  });

  it('judges an error without a tRPC envelope by connectivity', () => {
    expect(
      selectProfileReadErrorView({
        error: new Error('network request failed'),
        connectivity: 'offline',
      })
    ).toEqual({
      variant: 'offline',
      showRetry: true,
      titleKey: 'profiles.loadFailed',
      descriptionKey: null,
    });
  });
});

describe('pickReadError', () => {
  it('prefers the terminal error over a retryable one, wherever it sits', () => {
    // Two parallel reads fail for different reasons: only the terminal one says
    // why the surface cannot show anything, so it is the error to classify even
    // when the other read answered first.
    const retryable = makeTrpcError('INTERNAL_SERVER_ERROR');
    const terminal = makeTrpcError('FORBIDDEN');
    expect(pickReadError([retryable, terminal])).toBe(terminal);
    expect(pickReadError([terminal, retryable])).toBe(terminal);
  });

  it('takes the first non-nullish error when none is terminal', () => {
    const networkError = new Error('network request failed');
    expect(pickReadError([null, networkError, makeTrpcError('TIMEOUT')])).toBe(networkError);
  });

  it('returns null when every read settled without an error', () => {
    expect(pickReadError([undefined, null])).toBeNull();
    expect(pickReadError([])).toBeNull();
  });
});
