import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCClientError } from '@trpc/client';
import { WebhookRequestLogs } from './WebhookRequestLogs';
import { MessageErrorBoundary } from '@/components/cloud-agent-next/MessageErrorBoundary';

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
jest.mock('@/components/cloud-agent-next/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { parts: Array<{ text: string }> } }) =>
    React.createElement('div', { 'data-user-message': true }, message.parts[0]?.text),
}));
jest.mock('@/components/cloud-agent-next/PartRenderer', () => ({
  PartRenderer: ({ part }: { part: { text?: string; tool?: string } }) =>
    React.createElement('div', {}, part.text ?? part.tool),
}));
jest.mock('@/components/cloud-agent-next/LegacyMessageBubble', () => ({
  LegacyMessageBubble: ({ message }: { message: { text: string } }) =>
    React.createElement('div', { 'data-legacy-message': true }, message.text),
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

it('renders shared-session chat with collapsed tool work and escaped output', () => {
  mockUseQuery.mockReturnValue({
    data: {
      processStatus: 'success',
      logsReady: true,
      transcript: {
        version: 'v2',
        messages: [
          {
            info: { id: 'user', role: 'user' },
            parts: [{ type: 'text', text: 'Inspect the webhook' }],
          },
          {
            info: { id: 'assistant', role: 'assistant' },
            parts: [
              {
                type: 'tool',
                tool: 'bash',
                state: { status: 'completed', time: { start: 1, end: 1001 } },
              },
              { type: 'text', text: '<script>bad</script>' },
            ],
          },
        ],
      },
    },
  });
  const html = render();
  expect(html).toContain('data-user-message');
  expect(html).toContain('Inspect the webhook');
  expect(html).toContain('1 tool call');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(html).not.toContain('Auto-refreshing');
});

it('renders older runs with the existing legacy chat renderer', () => {
  mockUseQuery.mockReturnValue({
    data: {
      processStatus: 'success',
      transcript: {
        version: 'v1',
        messages: [{ ts: 1, type: 'assistant', text: 'Legacy response' }],
      },
    },
  });
  const html = render();
  expect(html).toContain('data-legacy-message');
  expect(html).toContain('Legacy response');
});

it('keeps agent failures visible when the assistant has no parts', () => {
  mockUseQuery.mockReturnValue({
    data: {
      processStatus: 'failed',
      transcript: {
        version: 'v2',
        messages: [{ info: { id: 'failed', role: 'assistant' }, parts: [] }],
      },
      logs: [{ timestamp: '', eventType: 'error', message: 'Error: Provider quota exceeded' }],
    },
  });
  const html = render();
  expect(html).toContain('role="alert"');
  expect(html).toContain('Error: Provider quota exceeded');
});

it('shows logged errors when no transcript messages render', () => {
  mockUseQuery.mockReturnValue({
    data: {
      processStatus: 'failed',
      transcript: { version: 'v2', messages: [] },
      logs: [{ timestamp: '', eventType: 'error', message: 'Error: Provider quota exceeded' }],
    },
  });
  const html = render();
  expect(html).toContain('role="alert"');
  expect(html).toContain('Error: Provider quota exceeded');
  expect(html).not.toContain('No execution logs available for this run');
});

it('recovers from a rendering failure on updated data without resetting healthy conversations', () => {
  const boundary = new MessageErrorBoundary({ children: null, resetKey: 2 });
  const setState = jest.spyOn(boundary, 'setState').mockImplementation(() => {});
  boundary.componentDidUpdate({ children: null, resetKey: 1 });
  expect(setState).not.toHaveBeenCalled();
  boundary.state = { hasError: true, error: new Error('Incomplete snapshot') };
  boundary.componentDidUpdate({ children: null, resetKey: 2 });
  expect(setState).not.toHaveBeenCalled();
  boundary.componentDidUpdate({ children: null, resetKey: 1 });
  expect(setState).toHaveBeenCalledWith({ hasError: false, error: undefined });
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
      transcript: {
        version: 'v1',
        messages: [{ ts: 1, type: 'assistant', text: 'Previously cached output' }],
      },
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
