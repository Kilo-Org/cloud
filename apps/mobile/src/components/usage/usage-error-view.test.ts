import { describe, expect, it } from 'vitest';

import { selectUsageErrorView, type UsageErrorView } from './usage-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

type Case = {
  name: string;
  error: unknown;
  expected: UsageErrorView;
};

const CASES: Case[] = [
  {
    name: 'keeps a 500-class failure on the retryable server state',
    error: makeTrpcError('INTERNAL_SERVER_ERROR'),
    expected: { variant: 'server', showRetry: true },
  },
  {
    name: 'keeps an error without a tRPC code retryable',
    error: new Error('network down'),
    expected: { variant: 'server', showRetry: true },
  },
  {
    name: 'maps FORBIDDEN to permission with no retry',
    error: makeTrpcError('FORBIDDEN'),
    expected: { variant: 'permission', showRetry: false },
  },
  {
    name: 'maps UNAUTHORIZED to permission with no retry',
    error: makeTrpcError('UNAUTHORIZED'),
    expected: { variant: 'permission', showRetry: false },
  },
  {
    name: 'maps NOT_FOUND to not-found with no retry',
    error: makeTrpcError('NOT_FOUND'),
    expected: { variant: 'not-found', showRetry: false },
  },
  {
    name: 'maps a terminal BAD_REQUEST to not-found, whose copy offers no retry',
    error: makeTrpcError('BAD_REQUEST'),
    expected: { variant: 'not-found', showRetry: false },
  },
  {
    name: 'maps a terminal UNPROCESSABLE_CONTENT to not-found, whose copy offers no retry',
    error: makeTrpcError('UNPROCESSABLE_CONTENT'),
    expected: { variant: 'not-found', showRetry: false },
  },
];

describe('selectUsageErrorView', () => {
  it.each(CASES)('$name', ({ error, expected }) => {
    expect(selectUsageErrorView(error)).toEqual(expected);
  });
});
