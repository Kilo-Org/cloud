import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @cloudflare/sandbox module before importing streaming utilities
vi.mock('@cloudflare/sandbox', () => ({
  parseSSEStream: vi.fn(),
  getSandbox: vi.fn(),
}));

import { streamKilocodeExecution } from './streaming.js';
import type { ExecutionSession, StreamEvent, SessionContext, SandboxInstance } from './types.js';
import { parseSSEStream } from '@cloudflare/sandbox';
import type { PersistenceEnv } from './persistence/types.js';

beforeEach(() => {
  vi.clearAllMocks();
});

async function collectEvents(generator: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

async function collectEventsUntilError(
  generator: AsyncGenerator<StreamEvent>
): Promise<{ events: StreamEvent[]; error: Error }> {
  const events: StreamEvent[] = [];
  let thrownError: Error | null = null;

  try {
    for await (const event of generator) {
      events.push(event);
    }
  } catch (error) {
    thrownError = error as Error;
  }

  if (!thrownError) {
    throw new Error('Expected generator to throw an error, but it did not');
  }

  return { events, error: thrownError };
}

function createMockSandbox(): SandboxInstance {
  return {} as SandboxInstance;
}

function createMockExecutionSession(mockExecStream: ReturnType<typeof vi.fn>): ExecutionSession & {
  writeFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
} {
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  const mockDeleteFile = vi.fn().mockResolvedValue(undefined);
  return {
    execStream: mockExecStream,
    writeFile: mockWriteFile,
    deleteFile: mockDeleteFile,
  } as unknown as ExecutionSession & {
    writeFile: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
  };
}

function mockStreamEvents(streamEvents: Array<Record<string, unknown>>) {
  vi.mocked(parseSSEStream).mockImplementation(async function* () {
    yield* streamEvents;
  });
}

function createSessionContext(workspacePath = '/workspace/test'): SessionContext {
  return {
    sandboxId: 'org-ctx__user-ctx',
    sessionId: 'agent_test_session',
    sessionHome: '/home/agent_test_session',
    workspacePath,
    branchName: 'session/agent_test_session',
    orgId: 'org-test',
    userId: 'user-test',
  };
}

function createFakeEnv(overrides?: {
  getMetadata?: ReturnType<typeof vi.fn>;
  clearInterrupted?: ReturnType<typeof vi.fn>;
  isInterrupted?: ReturnType<typeof vi.fn>;
  updateKiloSessionId?: ReturnType<typeof vi.fn>;
}) {
  const getMetadata = overrides?.getMetadata ?? vi.fn().mockResolvedValue(null);
  const clearInterrupted = overrides?.clearInterrupted ?? vi.fn().mockResolvedValue(undefined);
  const isInterrupted = overrides?.isInterrupted ?? vi.fn().mockResolvedValue(false);
  const updateKiloSessionId =
    overrides?.updateKiloSessionId ?? vi.fn().mockResolvedValue(undefined);

  const metadataDO = {
    getMetadata,
    clearInterrupted,
    isInterrupted,
    updateKiloSessionId,
  };

  const env = {
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(name => ({ name })),
      get: vi.fn(() => metadataDO),
    },
    SESSION_INGEST: {
      fetch: vi.fn(),
    },
  } as unknown as PersistenceEnv;

  return { env, metadataDO };
}

describe('streamKilocodeExecution', () => {
  it('streams kilocode JSON stdout and writes prompt file', async () => {
    const mockStream = [
      {
        type: 'stdout',
        data: '{"type":"tool_use","tool":"read_file","input":{"path":"test.ts"},"meta":"preserved"}\n',
      },
      {
        type: 'complete',
        exitCode: 0,
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const prompt = 'test prompt';
    const sessionContext = createSessionContext('/workspace/test');
    const events = await collectEvents(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', prompt, {
        sessionId: 'session-123',
      })
    );

    expect(mockSession.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/kilocode-prompt-'),
      prompt
    );
    expect(mockExecStream).toHaveBeenCalledTimes(1);
    const command = mockExecStream.mock.calls[0]?.[0] as string;
    expect(command).toContain('--mode=build');
    expect(command).toContain('--workspace=/workspace/test');
    expect(command).toContain('--json');

    expect(events).toEqual([
      {
        streamEventType: 'kilocode',
        payload: {
          type: 'tool_use',
          tool: 'read_file',
          input: { path: 'test.ts' },
          meta: 'preserved',
        },
        sessionId: 'session-123',
      },
    ]);
  });

  it('throws on non-zero exit code', async () => {
    const mockStream = [
      {
        type: 'complete',
        exitCode: 2,
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const { events, error } = await collectEventsUntilError(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(error.message).toBe('CLI exited with code 2');
  });

  it('throws descriptive error on timeout (exit code 124)', async () => {
    const mockStream = [
      {
        type: 'complete',
        exitCode: 124,
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const { events, error } = await collectEventsUntilError(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(error.message).toContain('exceeded the');
    expect(error.message).toContain('timeout limit');
    expect(error.message).toContain('900s'); // DEFAULT_CLI_TIMEOUT_SECONDS
    expect(error.message).toContain('Try simplifying your request');
  });

  it('emits error event when stream emits error type', async () => {
    const mockStream = [
      {
        type: 'error',
        error: 'Stream error occurred',
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const events = await collectEvents(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
        sessionId: 'stream-session',
      })
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      streamEventType: 'error',
      error: 'Stream error occurred',
      sessionId: 'stream-session',
    });
    expect(events[0]).toHaveProperty('timestamp');
  });

  it('splits stdout lines, ignoring blanks and mixing JSON with text', async () => {
    const mockStream = [
      {
        type: 'stdout',
        data: '{"type":"status","message":"Step 1"}\n\nPlain text output\n{"type":"status","message":"Step 2"}\n',
      },
      {
        type: 'complete',
        exitCode: 0,
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const events = await collectEvents(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      streamEventType: 'kilocode',
      payload: { type: 'status', message: 'Step 1' },
      sessionId: undefined,
    });
    expect(events[1]).toMatchObject({
      streamEventType: 'output',
      content: 'Plain text output',
      source: 'stdout',
    });
    expect(events[2]).toEqual({
      streamEventType: 'kilocode',
      payload: { type: 'status', message: 'Step 2' },
      sessionId: undefined,
    });
  });

  const ansiOutputCases = [
    {
      description: 'stdout',
      chunk: {
        type: 'stdout',
        data: '\u001b[32mGreen text\u001b[0m with \u001b[1mbold\u001b[0m\n',
      },
      expected: {
        source: 'stdout' as const,
        content: 'Green text with bold',
      },
    },
    {
      description: 'stderr',
      chunk: {
        type: 'stderr',
        data: '\u001b[31mError:\u001b[0m Something went \u001b[1;31mwrong\u001b[0m',
      },
      expected: {
        source: 'stderr' as const,
        content: 'Error: Something went wrong',
      },
    },
  ] as const;

  it.each(ansiOutputCases)('strips ANSI sequences from %s output', async ({ chunk, expected }) => {
    const mockStream = [chunk, { type: 'complete', exitCode: 0 }];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const events = await collectEvents(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      streamEventType: 'output',
      source: expected.source,
      content: expected.content,
    });
  });

  const ansiJsonPayload = {
    type: 'log',
    message: 'Output: \u001b[32mSuccess\u001b[0m',
    details: 'Contains ANSI codes in payload',
  };

  const ansiJsonCases = [
    {
      description: 'raw JSON containing ANSI sequences',
      line: JSON.stringify(ansiJsonPayload) + '\n',
    },
    {
      description: 'ANSI-prefixed JSON line',
      line: '\u001b[2K' + JSON.stringify(ansiJsonPayload) + '\n',
    },
    {
      description: 'JSON wrapped in multiple ANSI codes',
      line: '\u001b[2K\u001b[32m\u001b[1m' + JSON.stringify(ansiJsonPayload) + '\u001b[0m\n',
    },
  ] as const;

  it.each(ansiJsonCases)('preserves JSON payload for %s', async ({ line }) => {
    const mockStream = [
      {
        type: 'stdout',
        data: line,
      },
      {
        type: 'complete',
        exitCode: 0,
      },
    ];

    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    const events = await collectEvents(
      streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
    );

    expect(mockExecStream).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      streamEventType: 'kilocode',
      payload: ansiJsonPayload,
      sessionId: undefined,
    });
  });

  const sessionCases = [
    {
      description: 'with sessionId',
      options: { sessionId: 'session-abc-123' },
      expectedSessionId: 'session-abc-123',
    },
    {
      description: 'without sessionId',
      options: undefined,
      expectedSessionId: undefined,
    },
  ] as const;

  it.each(sessionCases)(
    'propagates sessionId to output events %s',
    async ({ options, expectedSessionId }) => {
      const mockStream = [
        {
          type: 'stdout',
          data: 'Plain text output\n',
        },
        {
          type: 'stderr',
          data: 'Error output',
        },
        {
          type: 'complete',
          exitCode: 0,
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'test prompt',
          options
        )
      );

      expect(mockExecStream).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        streamEventType: 'output',
        content: 'Plain text output',
        source: 'stdout',
      });
      expect(events[0]).toHaveProperty('sessionId', expectedSessionId);
      expect(events[1]).toMatchObject({
        streamEventType: 'output',
        content: 'Error output',
        source: 'stderr',
      });
      expect(events[1]).toHaveProperty('sessionId', expectedSessionId);
    }
  );

  it('does not fetch kiloSessionId when none is provided', async () => {
    const getMetadata = vi.fn().mockResolvedValue({ kiloSessionId: 'unused' });
    const { env: fakeEnv } = createFakeEnv({ getMetadata });

    const mockStream = [{ type: 'complete', exitCode: 0 }];
    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    await collectEvents(
      streamKilocodeExecution(
        mockSandbox,
        mockSession,
        sessionContext,
        'build',
        'prompt',
        undefined,
        fakeEnv
      )
    );

    expect(getMetadata).not.toHaveBeenCalled();
    const command = mockExecStream.mock.calls[0]?.[0] as string;
    expect(command).not.toContain('--session=');
  });

  it('uses provided kiloSessionId without fetching metadata', async () => {
    const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
    const getMetadata = vi.fn().mockResolvedValue({ kiloSessionId: 'should-not-be-used' });
    const { env: fakeEnv } = createFakeEnv({ getMetadata });

    const mockStream = [{ type: 'complete', exitCode: 0 }];
    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    await collectEvents(
      streamKilocodeExecution(
        mockSandbox,
        mockSession,
        sessionContext,
        'build',
        'prompt',
        { kiloSessionId, isFirstExecution: false },
        fakeEnv
      )
    );

    expect(getMetadata).not.toHaveBeenCalled();
    const command = mockExecStream.mock.calls[0]?.[0] as string;
    expect(command).toContain(`--session=${kiloSessionId}`);
  });

  it('skips kiloSessionId fetch on first execution', async () => {
    const getMetadata = vi.fn().mockResolvedValue({ kiloSessionId: 'should-not-be-used' });
    const { env: fakeEnv } = createFakeEnv({ getMetadata });

    const mockStream = [{ type: 'complete', exitCode: 0 }];
    const mockExecStream = vi.fn().mockResolvedValue(mockStream);
    const mockSession = createMockExecutionSession(mockExecStream);
    const mockSandbox = createMockSandbox();
    mockStreamEvents(mockStream);

    const sessionContext = createSessionContext('/workspace/test');
    await collectEvents(
      streamKilocodeExecution(
        mockSandbox,
        mockSession,
        sessionContext,
        'build',
        'prompt',
        { isFirstExecution: true },
        fakeEnv
      )
    );

    expect(getMetadata).not.toHaveBeenCalled();
    const command = mockExecStream.mock.calls[0]?.[0] as string;
    expect(command).not.toContain('--session=');
  });

  describe('terminal event handling', () => {
    it('terminates stream and emits error when api_req_failed event is received', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"say","say":"text","content":"Starting..."}\n',
        },
        {
          type: 'stdout',
          data: '{"type":"ask","ask":"api_req_failed","content":"Could not resolve authentication method"}\n',
        },
        // This event should NOT be reached
        {
          type: 'stdout',
          data: '{"type":"say","say":"text","content":"This should not appear"}\n',
        },
        {
          type: 'complete',
          exitCode: 0,
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      // Add listProcesses and killProcess mocks for cleanup
      (mockSandbox as unknown as Record<string, unknown>).listProcesses = vi
        .fn()
        .mockResolvedValue([]);
      (mockSession as unknown as Record<string, ReturnType<typeof vi.fn>>).killProcess = vi
        .fn()
        .mockResolvedValue(undefined);

      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-terminal',
        })
      );

      // Should have: first say event, the api_req_failed event, and then error event
      expect(events).toHaveLength(3);

      // First event: normal say event
      expect(events[0]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'say', say: 'text', content: 'Starting...' },
      });

      // Second event: the terminal api_req_failed event
      expect(events[1]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'ask', ask: 'api_req_failed' },
      });

      // Third event: error event
      expect(events[2]).toMatchObject({
        streamEventType: 'error',
        sessionId: 'session-terminal',
      });
      expect((events[2] as { error: string }).error).toContain(
        'Could not resolve authentication method'
      );
    });

    it('terminates stream and emits error when payment_required_prompt event is received', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"say","say":"text","content":"Starting task..."}\n',
        },
        {
          type: 'stdout',
          data: '{"type":"ask","ask":"payment_required_prompt","metadata":{"title":"Paid Model - Credits Required","message":"This is a paid model. To use paid models, you need to add credits.","balance":-0.02,"buyCreditsUrl":"https://app.kilo.ai/profile"}}\n',
        },
        // This event should NOT be reached
        {
          type: 'stdout',
          data: '{"type":"say","say":"text","content":"This should not appear"}\n',
        },
        {
          type: 'complete',
          exitCode: 0,
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      // Add listProcesses and killProcess mocks for cleanup
      (mockSandbox as unknown as Record<string, unknown>).listProcesses = vi
        .fn()
        .mockResolvedValue([]);
      (mockSession as unknown as Record<string, ReturnType<typeof vi.fn>>).killProcess = vi
        .fn()
        .mockResolvedValue(undefined);

      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-payment',
        })
      );

      // Should have: first say event, the payment_required_prompt event, and then error event
      expect(events).toHaveLength(3);

      // First event: normal say event
      expect(events[0]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'say', say: 'text', content: 'Starting task...' },
      });

      // Second event: the terminal payment_required_prompt event
      expect(events[1]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'ask', ask: 'payment_required_prompt' },
      });

      // Third event: error event with metadata.message as the error reason
      expect(events[2]).toMatchObject({
        streamEventType: 'error',
        sessionId: 'session-payment',
      });
      expect((events[2] as { error: string }).error).toContain(
        'This is a paid model. To use paid models, you need to add credits.'
      );
    });

    it('uses metadata.title as fallback when metadata.message is absent for payment_required_prompt', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"ask","ask":"payment_required_prompt","metadata":{"title":"Credits Required"}}\n',
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      (mockSandbox as unknown as Record<string, unknown>).listProcesses = vi
        .fn()
        .mockResolvedValue([]);
      (mockSession as unknown as Record<string, ReturnType<typeof vi.fn>>).killProcess = vi
        .fn()
        .mockResolvedValue(undefined);

      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-payment-title',
        })
      );

      // Should have the payment_required_prompt event and error event
      expect(events).toHaveLength(2);

      // Error should use metadata.title as fallback
      expect((events[1] as { error: string }).error).toBe('Credits Required');
    });

    it('calls listProcesses for cleanup after terminal event', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"ask","ask":"api_req_failed","content":"Auth failed"}\n',
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      const mockListProcesses = vi.fn().mockResolvedValue([
        {
          id: 'proc-123',
          status: 'running',
          command: 'kilocode --mode=code --workspace=/workspace/test --auto',
        },
      ]);
      const mockKillProcess = vi.fn().mockResolvedValue(undefined);

      (mockSandbox as unknown as Record<string, unknown>).listProcesses = mockListProcesses;
      (mockSession as unknown as Record<string, ReturnType<typeof vi.fn>>).killProcess =
        mockKillProcess;

      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
      );

      // Should have attempted to list and kill processes
      expect(mockListProcesses).toHaveBeenCalledTimes(1);
      expect(mockKillProcess).toHaveBeenCalledWith('proc-123', 'SIGTERM');
    });

    it('does not kill processes that are not kilocode or not in workspace', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"ask","ask":"api_req_failed","content":"Auth failed"}\n',
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      const mockListProcesses = vi.fn().mockResolvedValue([
        {
          id: 'proc-other',
          status: 'running',
          command: 'node server.js', // Not kilocode
        },
        {
          id: 'proc-different-workspace',
          status: 'running',
          command: 'kilocode --mode=code --workspace=/other/workspace --auto', // Different workspace
        },
        {
          id: 'proc-stopped',
          status: 'stopped',
          command: 'kilocode --mode=code --workspace=/workspace/test --auto', // Not running
        },
      ]);
      const mockKillProcess = vi.fn().mockResolvedValue(undefined);

      (mockSandbox as unknown as Record<string, unknown>).listProcesses = mockListProcesses;
      (mockSession as unknown as Record<string, ReturnType<typeof vi.fn>>).killProcess =
        mockKillProcess;

      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt')
      );

      // Should have listed processes but not killed any
      expect(mockListProcesses).toHaveBeenCalledTimes(1);
      expect(mockKillProcess).not.toHaveBeenCalled();
    });
  });

  describe('stream timeout', () => {
    it('clears timeout on normal completion', async () => {
      const mockStream = [
        {
          type: 'stdout',
          data: '{"type":"status","message":"done"}\n',
        },
        {
          type: 'complete',
          exitCode: 0,
        },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      (mockSandbox as unknown as Record<string, unknown>).listProcesses = vi
        .fn()
        .mockResolvedValue([]);

      mockStreamEvents(mockStream);

      // Use fake timers to ensure timeout doesn't actually fire
      vi.useFakeTimers();

      const sessionContext = createSessionContext('/workspace/test');
      const generator = streamKilocodeExecution(
        mockSandbox,
        mockSession,
        sessionContext,
        'build',
        'test prompt'
      );

      // Collect events without advancing time significantly
      const events: StreamEvent[] = [];
      for await (const event of generator) {
        events.push(event);
      }

      // Should complete normally
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'status', message: 'done' },
      });

      vi.useRealTimers();
    });
  });

  describe('kiloSessionId capture from session_created events', () => {
    it('calls updateKiloSessionId when valid UUID is received', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const updateKiloSessionId = vi.fn().mockResolvedValue(undefined);
      const { env: fakeEnv, metadataDO } = createFakeEnv({ updateKiloSessionId });

      const mockStream = [
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${validUuid}"}\n`,
        },
        { type: 'complete', exitCode: 0 },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'prompt',
          { skipInterruptPolling: true },
          fakeEnv
        )
      );

      expect(metadataDO.updateKiloSessionId).toHaveBeenCalledOnce();
      expect(metadataDO.updateKiloSessionId).toHaveBeenCalledWith(validUuid);
    });

    it('rejects invalid UUID format and does not call updateKiloSessionId', async () => {
      const invalidUuid = 'not-a-uuid';
      const updateKiloSessionId = vi.fn().mockResolvedValue(undefined);
      const { env: fakeEnv, metadataDO } = createFakeEnv({ updateKiloSessionId });

      const mockStream = [
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${invalidUuid}"}\n`,
        },
        { type: 'complete', exitCode: 0 },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'prompt',
          { skipInterruptPolling: true },
          fakeEnv
        )
      );

      expect(metadataDO.updateKiloSessionId).not.toHaveBeenCalled();
    });

    it('ignores duplicate session_created events after first capture', async () => {
      const firstUuid = '123e4567-e89b-12d3-a456-426614174000';
      const secondUuid = '987fcdeb-51a2-3bc4-d567-890123456789';
      const updateKiloSessionId = vi.fn().mockResolvedValue(undefined);
      const { env: fakeEnv, metadataDO } = createFakeEnv({ updateKiloSessionId });

      const mockStream = [
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${firstUuid}"}\n`,
        },
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${secondUuid}"}\n`,
        },
        { type: 'complete', exitCode: 0 },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'prompt',
          { skipInterruptPolling: true },
          fakeEnv
        )
      );

      // Should only be called once with the first UUID
      expect(metadataDO.updateKiloSessionId).toHaveBeenCalledOnce();
      expect(metadataDO.updateKiloSessionId).toHaveBeenCalledWith(firstUuid);
    });

    it('continues streaming if updateKiloSessionId fails', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      const updateKiloSessionId = vi.fn().mockRejectedValue(new Error('DO update failed'));
      const { env: fakeEnv } = createFakeEnv({ updateKiloSessionId });

      const mockStream = [
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${validUuid}"}\n`,
        },
        {
          type: 'stdout',
          data: '{"type":"say","say":"text","content":"Work continues"}\n',
        },
        { type: 'complete', exitCode: 0 },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'prompt',
          { skipInterruptPolling: true },
          fakeEnv
        )
      );

      // Should still emit both events despite DO failure
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { type: 'say', content: 'Work continues' },
      });
    });

    it('does not call updateKiloSessionId when env is not provided', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';

      const mockStream = [
        {
          type: 'stdout',
          data: `{"event":"session_created","sessionId":"${validUuid}"}\n`,
        },
        { type: 'complete', exitCode: 0 },
      ];

      const mockExecStream = vi.fn().mockResolvedValue(mockStream);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();
      mockStreamEvents(mockStream);

      const sessionContext = createSessionContext('/workspace/test');
      // No env provided - should not throw
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'prompt')
      );

      // Should still emit the session_created event as a kilocode event
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'kilocode',
        payload: { event: 'session_created', sessionId: validUuid },
      });
    });
  });

  describe('RPC disconnection handling', () => {
    function mockParseSSEStreamToThrow(errorMessage: string) {
      vi.mocked(parseSSEStream).mockImplementation(function () {
        return {
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw new Error(errorMessage);
          },
        };
      });
    }

    it('should emit interrupted event on RPC disconnection error', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('ReadableStream received over RPC disconnected prematurely');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-rpc-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-rpc-test',
        reason: 'Stream interrupted - please retry / resume',
      });
      expect(events[0]).toHaveProperty('timestamp');
    });

    it('should handle "Network connection lost" error', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('Network connection lost');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-network-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-network-test',
        reason: 'Stream interrupted - please retry / resume',
      });
    });

    it('should handle "Container service disconnected" error', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('Container service disconnected');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-container-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-container-test',
        reason: 'Stream interrupted - please retry / resume',
      });
    });

    it('should handle "Durable Object reset" error with deployment message', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('Durable Object reset because its code was updated.');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-deployment-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-deployment-test',
        reason: 'Stream interrupted - please retry / resume',
      });
    });

    it('should handle "Internal error in Durable Object storage" error', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('Internal error in Durable Object storage');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-do-storage-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-do-storage-test',
        reason: 'Stream interrupted - please retry / resume',
      });
    });

    it('should handle generic RPC error', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('RPC connection failed unexpectedly');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-generic-rpc-test',
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: 'session-generic-rpc-test',
        reason: 'Stream interrupted - please retry / resume',
      });
    });

    it('should NOT catch unrelated errors', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('Some other unrelated error');

      const sessionContext = createSessionContext('/workspace/test');
      const { events, error } = await collectEventsUntilError(
        streamKilocodeExecution(mockSandbox, mockSession, sessionContext, 'build', 'test prompt', {
          sessionId: 'session-unrelated-test',
        })
      );

      expect(events).toHaveLength(0);
      expect(error.message).toBe('Some other unrelated error');
    });

    it('should use sessionContext.sessionId when options.sessionId is not provided', async () => {
      const mockExecStream = vi.fn().mockResolvedValue([]);
      const mockSession = createMockExecutionSession(mockExecStream);
      const mockSandbox = createMockSandbox();

      mockParseSSEStreamToThrow('RPC disconnected');

      const sessionContext = createSessionContext('/workspace/test');
      const events = await collectEvents(
        streamKilocodeExecution(
          mockSandbox,
          mockSession,
          sessionContext,
          'build',
          'test prompt'
          // No options provided
        )
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamEventType: 'interrupted',
        sessionId: sessionContext.sessionId,
        reason: 'Stream interrupted - please retry / resume',
      });
    });
  });
});
