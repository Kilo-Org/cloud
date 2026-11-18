import { describe, expect, it } from 'vitest';

import { USAGE_SOURCE_NOT_CONFIGURED_MESSAGE } from '@kilocode/app-shared/usage-source';

import { selectUsageErrorView, type UsageErrorView } from './usage-error-view';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

function makeTrpcMessageError(message: string): unknown {
  return { data: { code: 'INTERNAL_SERVER_ERROR', message } };
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
    expected: { name: 'server', variant: 'server', showRetry: true },
  },
  {
    name: 'keeps an error without a tRPC code retryable',
    error: new Error('network down'),
    expected: { name: 'server', variant: 'server', showRetry: true },
  },
  {
    name: 'maps FORBIDDEN to permission with no retry',
    error: makeTrpcError('FORBIDDEN'),
    expected: { name: 'permission', variant: 'permission', showRetry: false },
  },
  {
    name: 'maps UNAUTHORIZED to permission with no retry',
    error: makeTrpcError('UNAUTHORIZED'),
    expected: { name: 'permission', variant: 'permission', showRetry: false },
  },
  {
    name: 'maps NOT_FOUND to not-found with no retry',
    error: makeTrpcError('NOT_FOUND'),
    expected: { name: 'not-found', variant: 'not-found', showRetry: false },
  },
  {
    name: 'maps a terminal BAD_REQUEST to not-found, whose copy offers no retry',
    error: makeTrpcError('BAD_REQUEST'),
    expected: { name: 'not-found', variant: 'not-found', showRetry: false },
  },
  {
    name: 'maps a terminal UNPROCESSABLE_CONTENT to not-found, whose copy offers no retry',
    error: makeTrpcError('UNPROCESSABLE_CONTENT'),
    expected: { name: 'not-found', variant: 'not-found', showRetry: false },
  },
  {
    name: 'maps the unconfigured usage-source message to the terminal unavailable state',
    error: makeTrpcMessageError(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE),
    expected: { name: 'unavailable', variant: 'server', showRetry: false },
  },
  {
    name: 'keeps the sanitized warehouse-failure message retryable, unlike the terminal one',
    error: makeTrpcMessageError('Usage data temporarily unavailable'),
    expected: { name: 'server', variant: 'server', showRetry: true },
  },
];

describe('selectUsageErrorView', () => {
  it.each(CASES)('$name', ({ error, expected }) => {
    expect(selectUsageErrorView(error)).toEqual(expected);
  });
});
