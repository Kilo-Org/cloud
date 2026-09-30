import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCClientError } from '@trpc/client';
import { WebhookRequestLogs } from './WebhookRequestLogs';

const mockPersonalOptions = jest.fn(() => ({ queryKey: ['personal'] }));
const mockAdminOptions = jest.fn(() => ({ queryKey: ['admin'] }));
const mockUseQuery = jest.fn();

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    webhookTriggers: { getRequestLogs: { queryOptions: mockPersonalOptions } },
    admin: { webhookTriggers: { getRequestLogs: { queryOptions: mockAdminOptions } } },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

function render(props: Partial<React.ComponentProps<typeof WebhookRequestLogs>> = {}) {
  return renderToStaticMarkup(
    React.createElement(WebhookRequestLogs, {
      triggerId: 'trigger',
      requestId: 'request',
      ...props,
    })
  );
}

beforeEach(() => {
  Object.assign(globalThis, { React });
  jest.clearAllMocks();
  mockUseQuery.mockReturnValue({
    data: { logs: [], processStatus: 'captured', logsReady: false },
    isLoading: false,
    isFetching: false,
    refetch: jest.fn(),
  });
});

it('loads logs by request and trigger in the organization scope without sharing a session', () => {
  expect(render({ organizationId: 'org' })).toContain('Waiting for cloud agent logs');
  expect(mockPersonalOptions).toHaveBeenCalledWith({
    triggerId: 'trigger',
    requestId: 'request',
    organizationId: 'org',
  });
  expect(mockAdminOptions).not.toHaveBeenCalled();
});

it('uses the separately authorized admin endpoint', () => {
  render({ adminScope: { scope: 'user', userId: 'owner' } });
  expect(mockAdminOptions).toHaveBeenCalledWith({
    triggerId: 'trigger',
    requestId: 'request',
    scope: 'user',
    userId: 'owner',
  });
  expect(mockPersonalOptions).not.toHaveBeenCalled();
});

it('renders tool details and escapes agent output', () => {
  mockUseQuery.mockReturnValue({
    data: {
      processStatus: 'success',
      logsReady: true,
      logs: [
        {
          timestamp: '',
          eventType: 'tool',
          message: 'Tool: bash',
          content: '<script>bad</script>',
        },
      ],
    },
  });
  const html = render();
  expect(html).toContain('Tool: bash');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(html).not.toContain('Auto-refreshing');
});

it('shows loading, empty terminal, and error states', () => {
  mockUseQuery.mockReturnValue({ isLoading: true });
  expect(render()).toContain('Loading execution logs');
  mockUseQuery.mockReturnValue({ data: { logs: [], processStatus: 'failed' } });
  expect(render()).toContain('No execution logs available for this run');
  mockUseQuery.mockReturnValue({ error: new Error('storage unavailable') });
  expect(render()).toContain('Failed to load execution logs');
});

it('polls active runs and bounds terminal reconciliation to 30 seconds', () => {
  jest.useFakeTimers();
  try {
    render();
    const options = mockUseQuery.mock.calls[0][0] as {
      refetchInterval: (query: { state: { data: { processStatus: string } } }) => number | false;
    };
    const active = { state: { data: { processStatus: 'inprogress' } } };
    const terminal = { state: { data: { processStatus: 'success' } } };
    expect(options.refetchInterval(active)).toBe(3000);
    expect(options.refetchInterval(terminal)).toBe(3000);
    jest.advanceTimersByTime(30_001);
    expect(options.refetchInterval(terminal)).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

it('stops polling and retrying when access is denied', () => {
  const error = new TRPCClientError('Forbidden', {
    result: {
      error: { message: 'Forbidden', code: -32003, data: { code: 'FORBIDDEN' } },
    },
  });
  mockUseQuery.mockReturnValue({
    error,
    data: {
      processStatus: 'inprogress',
      logs: [{ timestamp: '', eventType: 'text', message: 'Previously cached output' }],
    },
  });
  const html = render();
  expect(html).toContain('you do not have access to this run');
  expect(html).not.toContain('Previously cached output');
  const options = mockUseQuery.mock.calls[0][0] as {
    refetchInterval: (query: { state: { error: unknown } }) => number | false;
    retry: (count: number, error: unknown) => boolean;
  };
  expect(options.refetchInterval({ state: { error } })).toBe(false);
  expect(options.retry(0, error)).toBe(false);
  expect(options.retry(0, new Error('temporary'))).toBe(true);
  expect(options.retry(3, new Error('temporary'))).toBe(false);
});
