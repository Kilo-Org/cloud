/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as SessionFailureHistoryModule from './SessionFailureHistory';
import type { SessionFailureHistory as SessionFailureHistoryData } from './session-failure-summary';

const mockQuery: {
  data: SessionFailureHistoryData | undefined;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} = {
  data: undefined,
  isError: false,
  isFetching: false,
  refetch: jest.fn(),
};

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cloudAgentNextFailures: {
      getSessionFailureHistory: {
        queryOptions: () => ({}),
      },
      exportSessionDiagnostics: {
        queryOptions: () => ({}),
      },
    },
  }),
}));

jest.mock('@tanstack/react-query', () => ({
  skipToken: Symbol('skipToken'),
  useQueryClient: () => ({ fetchQuery: jest.fn() }),
  useQuery: () => mockQuery,
}));

const { SessionFailureHistory } =
  require('./SessionFailureHistory') as typeof SessionFailureHistoryModule;

Object.assign(globalThis, { React });

const CACHED_HISTORY: SessionFailureHistoryData = {
  session: {
    cloudAgentSessionId: 'agent_session',
    kiloSessionId: 'ses_failures',
    createdAt: '2035-01-10T00:00:00.000Z',
    organizationId: null,
    sandboxId: null,
    title: null,
    gitUrl: null,
  },
  setupFailure: {
    occurredAt: '2035-01-10T00:06:00.000Z',
    stage: 'initial_admission',
    code: 'initial_admission_rejected',
    responsibility: 'unknown',
    reason: null,
    userVisibleError: 'Environment preparation failed (admission rejected)',
    diagnostic: null,
    diagnosticExpiresAt: null,
  },
  runs: [],
  retention: { runWindowDays: 90, diagnosticDays: 30, historyRunLimit: 50 },
};

function renderHistory(cloudAgentSessionId = 'agent_session'): string {
  return renderToStaticMarkup(createElement(SessionFailureHistory, { cloudAgentSessionId }));
}

describe('SessionFailureHistory error state', () => {
  beforeEach(() => {
    mockQuery.data = undefined;
    mockQuery.isError = false;
    mockQuery.isFetching = false;
  });

  it('shows a retry panel when the query fails with no cached history', () => {
    mockQuery.data = undefined;
    mockQuery.isError = true;
    mockQuery.isFetching = false;

    const markup = renderHistory();
    expect(markup).toContain('Could not load failure history');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Download diagnostics');
  });

  it('keeps the failure list when a refetch fails but cached history remains', () => {
    mockQuery.data = CACHED_HISTORY;
    mockQuery.isError = true;
    mockQuery.isFetching = false;

    const markup = renderHistory();
    expect(markup).toContain('Environment setup failed');
    expect(markup).toContain('Download diagnostics');
    expect(markup).not.toContain('Try again');
  });

  it('hides the panel for unsupported session ids even when the query failed', () => {
    mockQuery.data = undefined;
    mockQuery.isError = true;

    expect(renderHistory('ses_not_cloud_agent')).toBe('');
  });
});
