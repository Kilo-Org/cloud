import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MirrorPayloadSchema } from '@kilocode/auto-routing-contracts';

const mockedWarnExceptInTest = jest.fn();

import { scheduleAutoRoutingMirror } from './auto-routing-mirror';

const originalFetch = globalThis.fetch;
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;

// body.model differs from requestedModel to mimic auto-model resolution
// mutating the parsed body after the mirror was scheduled; the captured
// requestedModel must win.
function makeParams() {
  return {
    apiKind: 'chat_completions' as const,
    body: {
      model: 'anthropic/claude-sonnet-4',
      stream: true,
      provider: { order: ['google'] },
      messages: [
        { role: 'system', content: 'You are Kilo Code.' },
        { role: 'user', content: 'Fix the parser bug.' },
      ],
    },
    requestedModel: 'kilo-auto/free',
    providerHints: { provider: { order: ['anthropic'] }, providerOptions: null },
    bodyBytes: 512,
    userId: 'user-1',
    sessionId: 'task-123',
    machineId: 'machine-1',
    clientRequestId: 'req-1',
    mode: 'code',
    userAgent: 'Kilo-Code/1.2.3',
  };
}

const options = {
  workerUrl: 'https://auto-routing.example.com',
  authToken: 'classifier-token',
};

describe('scheduleAutoRoutingMirror', () => {
  let scheduledWork: Array<() => void | Promise<void>>;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduledWork = [];
    globalThis.fetch = mockedFetch;
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('schedules a background mirror request with the normalized input and caller identity', async () => {
    scheduleAutoRoutingMirror(makeParams(), work => scheduledWork.push(work), options);

    expect(scheduledWork).toHaveLength(1);
    expect(mockedFetch).not.toHaveBeenCalled();
    await scheduledWork[0]();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('https://auto-routing.example.com/decide');
    expect(init).toMatchObject({ method: 'POST' });
    const payload = JSON.parse(init?.body as string);
    expect(payload).toEqual({
      input: {
        apiKind: 'chat_completions',
        requestedModel: 'kilo-auto/free',
        systemPromptPrefix: 'You are Kilo Code.',
        userPromptPrefix: 'Fix the parser bug.',
        latestUserPromptPrefix: null,
        messageCount: 2,
        hasTools: false,
        stream: true,
        providerHints: { provider: { order: ['anthropic'] }, providerOptions: null },
      },
      userId: 'user-1',
      sessionId: 'task-123',
      machineId: 'machine-1',
      clientRequestId: 'req-1',
      mode: 'code',
      userAgent: 'Kilo-Code/1.2.3',
      bodyBytes: 512,
    });
    // TypeScript cannot see the schema's runtime refinements (.trim().min(1)
    // etc.), so round-trip the built payload through the worker's validator.
    expect(() => MirrorPayloadSchema.parse(payload)).not.toThrow();

    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer classifier-token');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('skips mirroring when the body cannot be normalized, with a log for visibility', async () => {
    scheduleAutoRoutingMirror(
      { ...makeParams(), body: { stream: true } },
      work => scheduledWork.push(work),
      { ...options, onError: (message, data) => mockedWarnExceptInTest(message, data) }
    );
    await scheduledWork[0]();

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedWarnExceptInTest).toHaveBeenCalledWith(
      'Auto routing mirror skipped unclassifiable request body',
      { error: 'normalize_failed' }
    );
  });

  it('does not mirror organization-scoped requests', async () => {
    scheduleAutoRoutingMirror(
      { ...makeParams(), authContext: Promise.resolve({ organizationId: 'org-123' }) },
      work => scheduledWork.push(work),
      options
    );

    expect(scheduledWork).toHaveLength(1);
    await scheduledWork[0]();

    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('swallows worker failures', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('worker unavailable'));

    scheduleAutoRoutingMirror(makeParams(), work => scheduledWork.push(work), {
      ...options,
      onError: (message, data) => mockedWarnExceptInTest(message, data),
    });
    await scheduledWork[0]();

    expect(mockedWarnExceptInTest).toHaveBeenCalledWith('Auto routing mirror request failed', {
      error: 'worker unavailable',
    });
  });
});
