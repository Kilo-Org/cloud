import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { QueryClient, QueryClientProvider as ReactQueryProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { createRequire } from 'node:module';
import React, { act, createElement, type ComponentProps, type ReactNode } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';
import type {
  ConnectionState,
  createWebSocketManager,
  WebSocketManagerConfig,
} from '@/lib/cloud-agent-next/websocket-manager';
import type * as Constants from '@/lib/constants';
import type { RootRouter } from '@/routers/root-router';
import type { CodeReviewStreamView as CodeReviewStreamViewComponent } from './CodeReviewStreamView';
import type { fetchStreamTicket } from './fetch-stream-ticket';

type ReviewInput = { reviewId: string; attemptId?: string };
type ReviewOutputs = inferRouterOutputs<RootRouter>['codeReviews'];
type StreamInfo = ReviewOutputs['getReviewStreamInfo'];
type SessionMessages = ReviewOutputs['getSessionMessages'];
type ViewProps = ComponentProps<typeof CodeReviewStreamViewComponent>;
type Socket = {
  config: WebSocketManagerConfig;
  manager: ReturnType<typeof createWebSocketManager>;
};

const reviewId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const previousAttemptId = '00000000-0000-4000-8000-000000000003';
const currentAttemptId = '00000000-0000-4000-8000-000000000004';
const runtimeId = 'agent-current';
const timestamp = '2026-08-29T00:00:00.000Z';
const attempts: NonNullable<ViewProps['attempts']> = [
  {
    id: previousAttemptId,
    attempt_number: 1,
    retry_reason: null,
    session_id: 'agent-previous',
    cli_session_id: 'ses-previous',
    status: 'completed',
    error_message: null,
    terminal_reason: null,
  },
  {
    id: currentAttemptId,
    attempt_number: 2,
    retry_reason: 'manual_retry',
    session_id: runtimeId,
    cli_session_id: null,
    status: 'running',
    error_message: null,
    terminal_reason: null,
  },
];

const mockGetStreamInfo = jest.fn<(input: ReviewInput) => Promise<StreamInfo>>();
const mockGetMessages = jest.fn<(input: ReviewInput) => Promise<SessionMessages>>();
const mockFetchStreamTicket = jest.fn<typeof fetchStreamTicket>();
const mockCreateWebSocketManager = jest.fn<typeof createWebSocketManager>();
const mockOnComplete = jest.fn<() => void>();
const mockSockets: Socket[] = [];
let mockSearchParams = new URLSearchParams();
const mockRouter = {
  replace: jest.fn((url: string) => {
    mockSearchParams = new URL(url, 'http://localhost/').searchParams;
  }),
};

const mockTrpc = {
  codeReviews: {
    getReviewStreamInfo: {
      queryOptions: (input: ReviewInput) => ({
        queryKey: ['codeReviews', 'getReviewStreamInfo', input],
        queryFn: () => mockGetStreamInfo(input),
      }),
    },
    getSessionMessages: {
      queryOptions: (input: ReviewInput) => ({
        queryKey: ['codeReviews', 'getSessionMessages', input],
        queryFn: () => mockGetMessages(input),
      }),
    },
  },
};

jest.mock('@/lib/trpc/utils', () => ({ useTRPC: () => mockTrpc }));

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/code-reviews/review',
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/cloud-agent-next/websocket-manager', () => ({
  createWebSocketManager: (config: WebSocketManagerConfig) => mockCreateWebSocketManager(config),
}));

jest.mock('./fetch-stream-ticket', () => ({
  fetchStreamTicket: (sessionId: string, organizationId?: string) =>
    mockFetchStreamTicket(sessionId, organizationId),
}));

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual<typeof Constants>('@/lib/constants'),
  CLOUD_AGENT_NEXT_WS_URL: 'http://localhost:8787',
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) =>
    createElement(
      'select',
      {
        'aria-label': 'Select session attempt',
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange(event.currentTarget.value),
      },
      children
    ),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) =>
    createElement('option', { value }, children),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

type LinkedomModule = {
  parseHTML: (
    html: string,
    globals: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> & { location: URL }
  ) => { window: typeof globalThis; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { setTimeout, clearTimeout, location: new URL('http://localhost/') }
  );
  const container = document.getElementById('root');
  if (!container) throw new Error('React root missing');
  const globals = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    container,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

function streamInfo(overrides: Partial<Extract<StreamInfo, { success: true }>> = {}): StreamInfo {
  return {
    success: true,
    cloudAgentSessionId: runtimeId,
    organizationId,
    status: 'running',
    agentVersion: 'v2',
    ...overrides,
  };
}

function transcript(...messages: string[]): SessionMessages {
  return {
    success: true,
    entries: messages.map((message, index) => ({
      key: `part-${index}`,
      timestamp,
      message,
      eventType: 'text',
    })),
  };
}

let eventId = 0;

function streamEvent(
  streamEventType: string,
  data: unknown = {},
  executionId = 'exec-current'
): CloudAgentEvent {
  return {
    eventId: ++eventId,
    executionId,
    sessionId: runtimeId,
    streamEventType,
    timestamp,
    data,
  };
}

function textPart(text: string): CloudAgentEvent {
  return streamEvent('kilocode', {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt-current',
        sessionID: 'ses-current',
        messageID: 'msg-current',
        type: 'text',
        text,
        time: { start: Date.parse(timestamp) },
      },
    },
  });
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(milliseconds);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function settle(action: () => void) {
  await act(async () => {
    action();
  });
  await advanceTime(1);
  await advanceTime(1);
}

describe('CodeReviewStreamView', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let queryClient: QueryClient;
  let QueryClientProvider: typeof ReactQueryProvider;
  let createRoot: typeof createReactRoot;
  let CodeReviewStreamView: typeof CodeReviewStreamViewComponent;
  let props: ViewProps;

  async function renderView(nextProps: Partial<ViewProps> = {}) {
    props = { ...props, ...nextProps };
    await settle(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CodeReviewStreamView, props)
        )
      )
    );
  }

  function text() {
    return dom.container.textContent ?? '';
  }

  function status() {
    return dom.container.querySelector('[data-slot="badge"]')?.textContent?.trim();
  }

  function socket() {
    const current = mockSockets.at(-1);
    if (!current) throw new Error('WebSocket manager missing');
    return current;
  }

  async function navigateToAttempt(attemptId: string) {
    mockSearchParams = new URLSearchParams({ attemptId });
    await renderView();
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    eventId = 0;
    mockSockets.length = 0;
    mockSearchParams = new URLSearchParams();
    mockGetStreamInfo.mockReset().mockResolvedValue(streamInfo());
    mockGetMessages.mockReset().mockResolvedValue(transcript());
    mockFetchStreamTicket
      .mockReset()
      .mockResolvedValue({ ticket: 'test-ticket', expiresAt: 123456 });
    mockCreateWebSocketManager.mockReset().mockImplementation(config => {
      let state: ConnectionState = { status: 'disconnected' };
      const manager = {
        connect: jest.fn(() => {
          state = { status: 'connected', executionId: 'exec-current' };
          config.onStateChange(state);
        }),
        disconnect: jest.fn(() => {
          state = { status: 'disconnected' };
          config.onStateChange(state);
        }),
        getState: () => state,
      };
      mockSockets.push({ config, manager });
      return manager;
    });
    dom = installDom();
    const reactQuery = await import('@tanstack/react-query');
    expect(reactQuery.isServer).toBe(false);
    QueryClientProvider = reactQuery.QueryClientProvider;
    queryClient = new reactQuery.QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    ({ createRoot } = await import('react-dom/client'));
    ({ CodeReviewStreamView } = await import('./CodeReviewStreamView'));
    root = createRoot(dom.container);
    props = { reviewId, onComplete: mockOnComplete };
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
      queryClient?.clear();
    } finally {
      try {
        dom?.cleanup();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    }
  });

  it('replaces running organization snapshots every 2000 ms without requesting a bot-owner ticket', async () => {
    let snapshot = transcript('Inspecting changed files.', 'Temporary progress row.');
    mockGetMessages.mockImplementation(async () => snapshot);
    await renderView();
    expect(status()).toBe('Running');
    expect(text()).toContain('Inspecting changed files.');
    expect(text()).toContain('Temporary progress row.');
    expect(text()).toContain('Live');

    snapshot = transcript('Found a nullability regression.');
    await advanceTime(2000);
    expect(text()).toContain('Found a nullability regression.');
    expect(text()).not.toContain('Inspecting changed files.');
    expect(text()).not.toContain('Temporary progress row.');
    expect(mockGetMessages).toHaveBeenCalledTimes(2);
    expect(mockGetStreamInfo).toHaveBeenCalledTimes(2);

    snapshot = transcript();
    await advanceTime(2000);
    expect(text()).not.toContain('Found a nullability regression.');
    expect(text()).toContain('Waiting for events');

    snapshot = transcript('Checking the remaining files.');
    await advanceTime(2000);
    expect(text()).toContain('Checking the remaining files.');
    expect(status()).toBe('Running');
    expect(mockGetMessages).toHaveBeenCalledWith({ reviewId, attemptId: undefined });
    expect(mockGetStreamInfo).toHaveBeenCalledTimes(4);
    expect(mockFetchStreamTicket).not.toHaveBeenCalled();
    expect(mockCreateWebSocketManager).not.toHaveBeenCalled();
    expect(mockOnComplete).not.toHaveBeenCalled();
  });

  it('refetches persisted history after partial organization progress and stops terminal polling', async () => {
    const terminalStatus = Promise.withResolvers<StreamInfo>();
    mockGetMessages.mockResolvedValue(transcript('Partial organization progress.'));
    mockGetStreamInfo
      .mockResolvedValueOnce(streamInfo())
      .mockReturnValueOnce(terminalStatus.promise);
    await renderView();
    expect(text()).toContain('Partial organization progress.');
    await advanceTime(2000);
    expect(status()).toBe('Running');
    const liveRequests = mockGetMessages.mock.calls.length;

    const completed = streamInfo({ status: 'completed' });
    mockGetStreamInfo.mockResolvedValue(completed);
    mockGetMessages.mockResolvedValue(transcript('Persisted organization assessment.'));
    await settle(() => terminalStatus.resolve(completed));
    expect(status()).toBe('Complete');
    expect(text()).toContain('Session Log');
    expect(text()).toContain('Persisted organization assessment.');
    expect(text()).not.toContain('Final verdict.');
    expect(text()).not.toContain('Partial organization progress.');
    expect(text()).not.toContain('Live');
    expect(mockGetMessages.mock.calls.length).toBeGreaterThan(liveRequests);
    expect(mockOnComplete).toHaveBeenCalledTimes(1);

    mockGetMessages.mockResolvedValueOnce({ success: false, error: 'Transcript is syncing.' });
    await advanceTime(2000);
    expect(text()).toContain('Transcript is syncing.');
    mockGetMessages.mockResolvedValue(
      transcript('Persisted organization assessment.', 'Final verdict.')
    );
    await advanceTime(2000);
    expect(text()).toContain('Final verdict.');
    expect(text()).not.toContain('Transcript is syncing.');
    await advanceTime(8000);
    const requests = [mockGetStreamInfo.mock.calls.length, mockGetMessages.mock.calls.length];
    mockGetMessages.mockResolvedValue(transcript('Unexpected post-terminal update.'));
    await advanceTime(6000);
    expect([mockGetStreamInfo.mock.calls.length, mockGetMessages.mock.calls.length]).toEqual(
      requests
    );
    expect(text()).toContain('Persisted organization assessment.');
    expect(text()).not.toContain('Unexpected post-terminal update.');
    expect(mockFetchStreamTicket).not.toHaveBeenCalled();
  });

  it('renders canonical personal text, survives replayed completion, and reconciles authoritative completion', async () => {
    const running = streamInfo({ organizationId: undefined });
    mockGetStreamInfo.mockResolvedValue(running);
    await renderView();
    expect(mockFetchStreamTicket).toHaveBeenCalledWith(runtimeId, undefined);
    const live = socket();
    await settle(() => live.config.onEvent(textPart('Draft assessment.')));
    expect(text()).toContain('Draft assessment.');
    expect(status()).toBe('Running');
    expect(mockGetMessages).not.toHaveBeenCalled();

    for (const type of ['complete', 'interrupted']) {
      const authoritativeStatus = Promise.withResolvers<StreamInfo>();
      const requests = mockGetStreamInfo.mock.calls.length;
      mockGetStreamInfo.mockReturnValueOnce(authoritativeStatus.promise);
      await settle(() => live.config.onEvent(streamEvent(type, {}, 'exec-previous')));
      expect(mockGetStreamInfo).toHaveBeenCalledTimes(requests + 1);
      expect(status()).toBe('Running');
      expect(live.manager.disconnect).not.toHaveBeenCalled();
      await settle(() => authoritativeStatus.resolve(running));
      expect(status()).toBe('Running');
      expect(text()).toContain('Draft assessment.');
      expect(live.manager.disconnect).not.toHaveBeenCalled();
      expect(mockOnComplete).not.toHaveBeenCalled();
    }

    await settle(() => live.config.onEvent(textPart('Current execution is still reviewing.')));
    expect(text()).toContain('Current execution is still reviewing.');
    expect(text()).not.toContain('Draft assessment.');
    expect(text()).toContain('Live');
    expect(mockCreateWebSocketManager).toHaveBeenCalledTimes(1);
    expect(mockGetMessages).not.toHaveBeenCalled();

    mockGetStreamInfo.mockResolvedValue(
      streamInfo({ organizationId: undefined, status: 'completed' })
    );
    mockGetMessages.mockResolvedValue(
      transcript('Persisted personal assessment.', 'Final personal verdict.')
    );
    await settle(() => live.config.onEvent(streamEvent('complete')));
    expect(status()).toBe('Complete');
    expect(text()).toContain('Persisted personal assessment.');
    expect(text()).toContain('Final personal verdict.');
    expect(text()).not.toContain('Current execution is still reviewing.');
    expect(text()).not.toContain('Live');
    expect(live.manager.disconnect).toHaveBeenCalled();
    expect(mockOnComplete).toHaveBeenCalledTimes(1);
    const requests = mockGetStreamInfo.mock.calls.length;
    await advanceTime(6000);
    expect(mockGetStreamInfo).toHaveBeenCalledTimes(requests);
    expect(mockCreateWebSocketManager).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Persisted personal assessment.');
  });

  it('shows running metadata and transcript errors, then hides revoked data and stops polling', async () => {
    mockGetMessages.mockResolvedValue(transcript('Organization-only transcript.'));
    await renderView();
    expect(text()).toContain('Organization-only transcript.');
    expect(status()).toBe('Running');

    mockGetStreamInfo.mockResolvedValueOnce({
      success: false,
      error: 'Review metadata unavailable.',
    });
    await advanceTime(2000);
    expect(text()).toContain('Review metadata unavailable.');
    expect(mockOnComplete).not.toHaveBeenCalled();

    mockGetMessages.mockResolvedValueOnce({
      success: false,
      error: 'Review transcript unavailable.',
    });
    await advanceTime(2000);
    expect(text()).toContain('Review transcript unavailable.');
    expect(text()).not.toContain('Review metadata unavailable.');
    expect(mockOnComplete).not.toHaveBeenCalled();

    await advanceTime(2000);
    expect(text()).toContain('Organization-only transcript.');
    expect(text()).not.toContain('Review transcript unavailable.');
    expect(status()).toBe('Running');

    mockGetMessages.mockRejectedValue(
      TRPCClientError.from<RootRouter>({
        error: {
          code: -32003,
          message: 'Organization membership revoked.',
          data: { code: 'FORBIDDEN', httpStatus: 403 },
        },
      })
    );
    await advanceTime(2000);
    expect(text()).toContain('Organization membership revoked.');
    expect(text()).not.toContain('Organization-only transcript.');
    expect(text()).not.toContain(runtimeId);
    const requests = [mockGetStreamInfo.mock.calls.length, mockGetMessages.mock.calls.length];
    await advanceTime(6000);
    expect([mockGetStreamInfo.mock.calls.length, mockGetMessages.mock.calls.length]).toEqual(
      requests
    );
    expect(text()).not.toContain('Organization-only transcript.');
    expect(mockFetchStreamTicket).not.toHaveBeenCalled();
    expect(mockOnComplete).not.toHaveBeenCalled();
  });

  it('keeps attempt selection available when a historical transcript fails', async () => {
    mockSearchParams = new URLSearchParams({ attemptId: previousAttemptId });
    mockGetStreamInfo.mockImplementation(async input =>
      streamInfo({
        status: input.attemptId === previousAttemptId ? 'completed' : 'running',
        cloudAgentSessionId: input.attemptId === previousAttemptId ? 'agent-previous' : runtimeId,
      })
    );
    mockGetMessages.mockImplementation(async input =>
      input.attemptId === previousAttemptId
        ? { success: false, error: 'Historical transcript unavailable.' }
        : transcript('Current attempt progress.')
    );
    await renderView({ attempts });
    expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Historical transcript unavailable.'
    );

    const selector = dom.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Select session attempt"]'
    );
    expect(selector).not.toBeNull();
    if (!selector) throw new Error('Attempt selector missing');
    await settle(() => {
      for (const option of selector.options) {
        option.selected = option.value === currentAttemptId;
      }
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await renderView();

    expect(status()).toBe('Running');
    expect(text()).toContain('Current attempt progress.');
    expect(text()).not.toContain('Historical transcript unavailable.');
  });

  it('resets organization attempts and ignores late transcript and status responses', async () => {
    const lateMessages = Promise.withResolvers<SessionMessages>();
    const lateStatus = Promise.withResolvers<StreamInfo>();
    const history = Promise.withResolvers<SessionMessages>();
    mockSearchParams = new URLSearchParams({ attemptId: currentAttemptId });
    mockGetStreamInfo.mockImplementation(async input =>
      streamInfo({
        status: input.attemptId === previousAttemptId ? 'completed' : 'running',
        cloudAgentSessionId: input.attemptId === previousAttemptId ? 'agent-previous' : runtimeId,
      })
    );
    mockGetMessages.mockImplementation(input =>
      input.attemptId === previousAttemptId
        ? history.promise
        : Promise.resolve(transcript('Current attempt progress.'))
    );
    await renderView({ attempts });
    expect(text()).toContain('Current attempt progress.');
    mockGetMessages.mockReturnValueOnce(lateMessages.promise);
    mockGetStreamInfo.mockReturnValueOnce(lateStatus.promise);
    await advanceTime(2000);

    await navigateToAttempt(previousAttemptId);
    expect(text()).not.toContain('Current attempt progress.');
    await settle(() => {
      lateMessages.resolve(transcript('Late unselected transcript.'));
      lateStatus.resolve(streamInfo({ status: 'failed' }));
    });
    expect(text()).not.toContain('Late unselected transcript.');
    expect(status()).toBe('Complete');
    await settle(() => history.resolve(transcript('Selected attempt history.')));
    expect(text()).toContain('Selected attempt history.');
    expect(text()).not.toContain('Current attempt progress.');
    expect(mockGetMessages).toHaveBeenCalledWith({ reviewId, attemptId: previousAttemptId });

    await navigateToAttempt(currentAttemptId);
    expect(status()).toBe('Running');
    expect(text()).toContain('Current attempt progress.');
    expect(text()).not.toContain('Selected attempt history.');
    expect(text()).not.toContain('Late unselected transcript.');
    mockGetMessages.mockResolvedValue(transcript('Resumed current attempt progress.'));
    await advanceTime(2000);
    expect(text()).toContain('Resumed current attempt progress.');
    expect(status()).toBe('Running');
    expect(mockFetchStreamTicket).not.toHaveBeenCalled();
  });

  it('reconciles completion after switching between cached running attempts', async () => {
    queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: Infinity, staleTime: 60_000 },
    });
    mockSearchParams = new URLSearchParams({ attemptId: previousAttemptId });
    let completed = false;
    let currentTranscript = transcript('Current cached progress.');
    mockGetStreamInfo.mockImplementation(async input =>
      streamInfo({
        status: input.attemptId === currentAttemptId && completed ? 'completed' : 'running',
      })
    );
    mockGetMessages.mockImplementation(async input =>
      input.attemptId === previousAttemptId
        ? transcript('Previous cached progress.')
        : currentTranscript
    );
    for (const attempt of attempts) {
      const input = { reviewId, attemptId: attempt.id };
      queryClient.setQueryData(
        mockTrpc.codeReviews.getReviewStreamInfo.queryOptions(input).queryKey,
        streamInfo()
      );
      queryClient.setQueryData(
        mockTrpc.codeReviews.getSessionMessages.queryOptions(input).queryKey,
        attempt.id === previousAttemptId
          ? transcript('Previous cached progress.')
          : currentTranscript
      );
    }
    await renderView({ attempts: attempts.map(attempt => ({ ...attempt, status: 'running' })) });
    expect(text()).toContain('Previous cached progress.');
    await navigateToAttempt(currentAttemptId);
    expect(text()).toContain('Current cached progress.');
    expect(text()).not.toContain('Previous cached progress.');

    completed = true;
    await advanceTime(2000);
    expect(status()).toBe('Complete');
    currentTranscript = transcript('Final result from the selected attempt.');
    await advanceTime(2000);
    expect(text()).toContain('Final result from the selected attempt.');
    expect(text()).not.toContain('Current cached progress.');
  });

  it('shows live WebSocket errors and ignores stale callbacks and tickets after attempt switches', async () => {
    mockSearchParams = new URLSearchParams({ attemptId: currentAttemptId });
    mockGetStreamInfo.mockImplementation(async input =>
      streamInfo({
        organizationId: undefined,
        status: input.attemptId === previousAttemptId ? 'completed' : 'running',
        cloudAgentSessionId: input.attemptId === previousAttemptId ? 'agent-previous' : runtimeId,
      })
    );
    mockGetMessages.mockResolvedValue(transcript('Previous personal attempt history.'));
    await renderView({ attempts });
    const live = socket();
    await settle(() => live.config.onEvent(textPart('Current personal attempt progress.')));
    expect(text()).toContain('Current personal attempt progress.');
    await settle(() =>
      live.config.onError?.({
        type: 'error',
        code: 'WS_INTERNAL_ERROR',
        message: 'Live transport failed.',
      })
    );
    expect(text()).toContain('Live transport failed.');
    expect(mockOnComplete).not.toHaveBeenCalled();

    await navigateToAttempt(previousAttemptId);
    expect(live.manager.disconnect).toHaveBeenCalled();
    expect(text()).toContain('Previous personal attempt history.');
    expect(text()).not.toContain('Current personal attempt progress.');
    expect(text()).not.toContain('Live transport failed.');
    await settle(() => {
      live.config.onEvent(textPart('Late disconnected stream text.'));
      live.config.onError?.({
        type: 'error',
        code: 'WS_AUTH_ERROR',
        message: 'Late stream error.',
      });
    });
    expect(text()).toContain('Previous personal attempt history.');
    expect(text()).not.toContain('Late disconnected stream text.');
    expect(text()).not.toContain('Late stream error.');
    expect(status()).toBe('Complete');

    const lateTicket = Promise.withResolvers<Awaited<ReturnType<typeof fetchStreamTicket>>>();
    mockFetchStreamTicket.mockReturnValueOnce(lateTicket.promise);
    await navigateToAttempt(currentAttemptId);
    expect(text()).not.toContain('Previous personal attempt history.');
    expect(mockFetchStreamTicket).toHaveBeenCalledTimes(2);
    await navigateToAttempt(previousAttemptId);
    await settle(() => lateTicket.resolve({ ticket: 'late-ticket', expiresAt: 123456 }));
    expect(mockCreateWebSocketManager).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Previous personal attempt history.');
    expect(text()).not.toContain('Late disconnected stream text.');
    expect(status()).toBe('Complete');
  });
});
