import { describe, expect, it } from 'vitest';

import { selectUsageErrorView, type UsageErrorView } from './usage-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

type Case = {
  name: string;
  error: unknown;
  paused: boolean;
  expected: UsageErrorView;
};

const CASES: Case[] = [
  {
    name: 'keeps a 500-class failure on the retryable server state',
    error: makeTrpcError('INTERNAL_SERVER_ERROR'),
    paused: false,
    expected: { variant: 'server', showRetry: true },
  },
  {
    name: 'keeps an error without a tRPC code retryable',
    error: new Error('network down'),
    paused: false,
    expected: { variant: 'server', showRetry: true },
  },
  {
    name: 'maps FORBIDDEN to permission with no retry',
    error: makeTrpcError('FORBIDDEN'),
    paused: false,
    expected: { variant: 'permission', showRetry: false },
  },
  {
    name: 'maps UNAUTHORIZED to permission with no retry',
    error: makeTrpcError('UNAUTHORIZED'),
    paused: false,
    expected: { variant: 'permission', showRetry: false },
  },
  {
    name: 'maps NOT_FOUND to not-found with no retry',
    error: makeTrpcError('NOT_FOUND'),
    paused: false,
    expected: { variant: 'not-found', showRetry: false },
  },
  {
    name: 'keeps a terminal BAD_REQUEST on the server state without a retry',
    error: makeTrpcError('BAD_REQUEST'),
    paused: false,
    expected: { variant: 'server', showRetry: false },
  },
  {
    name: 'keeps a terminal UNPROCESSABLE_CONTENT on the server state without a retry',
    error: makeTrpcError('UNPROCESSABLE_CONTENT'),
    paused: false,
    expected: { variant: 'server', showRetry: false },
  },
  {
    name: 'names a paused 500 as offline, still retryable',
    error: makeTrpcError('INTERNAL_SERVER_ERROR'),
    paused: true,
    expected: { variant: 'offline', showRetry: true },
  },
  {
    name: 'keeps a paused denial on permission, because the server answered',
    error: makeTrpcError('FORBIDDEN'),
    paused: true,
    expected: { variant: 'permission', showRetry: false },
  },
];

describe('selectUsageErrorView', () => {
  it.each(CASES)('$name', ({ error, paused, expected }) => {
    expect(selectUsageErrorView(error, paused)).toEqual(expected);
  });
});
