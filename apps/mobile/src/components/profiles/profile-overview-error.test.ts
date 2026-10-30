import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import { selectProfileOverviewErrorView } from '@/components/profiles/profile-overview-error';

describe('selectProfileOverviewErrorView', () => {
  it('treats NOT_FOUND as a stale list row: no retry, list refresh, not-found copy', () => {
    expect(
      selectProfileOverviewErrorView({ data: { code: 'NOT_FOUND', httpStatus: 404 } }, 'online')
    ).toEqual({ variant: 'not-found', showRetry: false, staleRow: true });
  });

  it('keeps the not-found state when the device reports offline: the server answered', () => {
    expect(
      selectProfileOverviewErrorView({ data: { code: 'NOT_FOUND', httpStatus: 404 } }, 'offline')
    ).toEqual({ variant: 'not-found', showRetry: false, staleRow: true });
  });

  it('treats a refused permission as terminal without refreshing the list', () => {
    expect(
      selectProfileOverviewErrorView({ data: { code: 'FORBIDDEN', httpStatus: 403 } }, 'online')
    ).toEqual({ variant: 'permission', showRetry: false, staleRow: false });
  });

  it('keeps other terminal codes out of the retry loop without claiming a stale row', () => {
    expect(
      selectProfileOverviewErrorView({ data: { code: 'BAD_REQUEST', httpStatus: 400 } }, 'online')
    ).toEqual({ variant: 'not-found', showRetry: false, staleRow: false });
  });

  it('offers retry for an error without a code while the device is confirmed offline', () => {
    expect(selectProfileOverviewErrorView(new Error('aborted'), 'offline')).toEqual({
      variant: 'offline',
      showRetry: true,
      staleRow: false,
    });
  });

  it('names a deadline abort as the retryable slow-response state', () => {
    expect(selectProfileOverviewErrorView(new RequestDeadlineError(15_000), 'online')).toEqual({
      variant: 'timeout',
      showRetry: true,
      staleRow: false,
    });
  });

  it('offers retry with the server variant for an unclassified failure', () => {
    expect(
      selectProfileOverviewErrorView({ data: { code: 'INTERNAL_SERVER_ERROR' } }, 'online')
    ).toEqual({ variant: 'server', showRetry: true, staleRow: false });
    expect(selectProfileOverviewErrorView(undefined, 'unknown')).toEqual({
      variant: 'server',
      showRetry: true,
      staleRow: false,
    });
  });
});
