import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClassifierConfigCache } from './classifier-config';
import { app } from './index';
import { ClassifierRunError } from './model-classifier';
import type * as ModelClassifierModule from './model-classifier';

const classifyNormalizedInput = vi.hoisted(() => vi.fn());

vi.mock('./model-classifier', async importOriginal => {
  const actual = await importOriginal<typeof ModelClassifierModule>();
  return { ...actual, classifyNormalizedInput };
});

const writeDataPoint = vi.fn();
const configGet = vi.fn();
const configPut = vi.fn();
const analyticsTokenGet = vi.fn();
const cacheGetEntry = vi.fn();
const cachePutEntry = vi.fn();
const cacheIdFromName = vi.fn(() => 'cache-do-id');
const originalFetch = globalThis.fetch;
const mockedFetch = vi.fn<typeof globalThis.fetch>();

const env = {
  INTERNAL_API_SECRET_PROD: {
    get: async () => 'classifier-token',
  },
  AUTO_ROUTING_CONFIG: {
    get: configGet,
    put: configPut,
  },
  AUTO_ROUTING_CLASSIFIER_METRICS: {
    writeDataPoint,
  },
  AUTO_ROUTING_DECISION_CACHE: {
    idFromName: cacheIdFromName,
    get: () => ({ getEntry: cacheGetEntry, putEntry: cachePutEntry }),
  },
  O11Y_CF_ACCOUNT_ID: 'test-account-id',
  O11Y_CF_AE_API_TOKEN: {
    get: analyticsTokenGet,
  },
};

const mockClassification = {
  taskType: 'implementation',
  subtaskType: 'feature_development',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'low',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.82,
};

const mockClassifierResult = {
  cost: 0.00000123,
  classifierModel: 'google/gemini-2.5-flash-lite',
  classification: mockClassification,
};

// Node-environment tests have no workers ExecutionContext; Hono accepts a
// substitute so handler code can use c.executionCtx.waitUntil directly.
const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://auto-routing.example.com${path}`, init, env, executionCtx);
}

function localRequest(path: string, init: RequestInit = {}) {
  return app.request(`http://localhost:8810${path}`, init, env, executionCtx);
}

describe('auto routing worker', () => {
  beforeEach(() => {
    clearClassifierConfigCache();
    classifyNormalizedInput.mockReset();
    classifyNormalizedInput.mockResolvedValue(mockClassifierResult);
    writeDataPoint.mockReset();
    configGet.mockReset();
    configPut.mockReset();
    analyticsTokenGet.mockReset();
    analyticsTokenGet.mockResolvedValue('analytics-token');
    cacheGetEntry.mockReset();
    cacheGetEntry.mockResolvedValue(null);
    cachePutEntry.mockReset();
    cachePutEntry.mockResolvedValue(undefined);
    mockedFetch.mockReset();
    globalThis.fetch = mockedFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns health without requiring classifier payload fields', async () => {
    const response = await request('/health', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'auto-routing',
    });
  });

  it('normalizes mirrored chat completion requests', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: 'task-123',
        headers: {
          authorization: 'Bearer user-token',
          'x-kilocode-version': '1.2.3',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          stream: true,
          provider: { order: ['anthropic'] },
          providerOptions: { openrouter: { sort: 'price', apiKey: 'secret-key' } },
          tools: [{ type: 'function', function: { name: 'search' } }],
          messages: [
            { role: 'system', content: 'You classify auto model routing requests.' },
            { role: 'assistant', content: 'Ready.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Pick the best model for this request.' },
                { type: 'image_url', image_url: { url: 'https://example.com/car.png' } },
              ],
            },
          ],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0.00000123,
      decision: null,
      classifierResult: {
        classification: mockClassification,
        normalized: {
          apiKind: 'chat_completions',
          requestedModel: 'anthropic/claude-sonnet-4',
          systemPromptPrefix: 'You classify auto model routing requests.',
          userPromptPrefix: 'Pick the best model for this request.',
          latestUserPromptPrefix: null,
          messageCount: 3,
          hasTools: true,
          stream: true,
          providerHints: {
            provider: { order: ['anthropic'] },
            providerOptions: { openrouter: { sort: 'price', apiKey: '[REDACTED]' } },
          },
        },
      },
    });
    expect(classifyNormalizedInput).toHaveBeenCalledWith(
      env,
      {
        apiKind: 'chat_completions',
        requestedModel: 'anthropic/claude-sonnet-4',
        systemPromptPrefix: 'You classify auto model routing requests.',
        userPromptPrefix: 'Pick the best model for this request.',
        latestUserPromptPrefix: null,
        messageCount: 3,
        hasTools: true,
        stream: true,
        providerHints: {
          provider: { order: ['anthropic'] },
          providerOptions: { openrouter: { sort: 'price', apiKey: '[REDACTED]' } },
        },
      },
      'google/gemini-2.5-flash-lite',
      { openrouterSessionId: 'task-123' }
    );
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'chat_completions',
        'classified',
        'implementation',
        'feature_development',
        'medium',
        'medium',
        'code_change',
        '1',
        '0.8-1.0',
        'task-123',
      ],
      doubles: [expect.any(Number), 0.00000123, 0.82, 3, 1, expect.any(Number), 0],
    });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('serves a cached classification for the session without calling the classifier', async () => {
    cacheGetEntry.mockResolvedValueOnce(mockClassification);

    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: 'task-123',
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0,
      decision: null,
      classifierResult: { classification: mockClassification },
    });
    expect(cacheIdFromName).toHaveBeenCalledWith('task-123');
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(cachePutEntry).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        doubles: [0, 0, mockClassification.confidence, 1, 0, expect.any(Number), 1],
      })
    );
  });

  it('caches fresh classifications for the conversation', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    // Without a session id the conversation key is derived from content.
    expect(cacheIdFromName).toHaveBeenCalledWith(expect.stringMatching(/^content:[0-9a-f]{16}$/));
    expect(cachePutEntry).toHaveBeenCalledWith(
      expect.stringMatching(/^google\/gemini-2\.5-flash-lite:[0-9a-f]{16}$/),
      expect.objectContaining({ taskType: 'implementation' })
    );
  });

  it('uses a zero cost when the classifier result has no usage cost', async () => {
    classifyNormalizedInput.mockResolvedValueOnce({
      cost: null,
      classification: mockClassification,
    });

    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0,
      decision: null,
      classifierResult: {
        classification: mockClassification,
        normalized: {
          apiKind: 'chat_completions',
          requestedModel: 'anthropic/claude-sonnet-4',
          systemPromptPrefix: null,
          userPromptPrefix: 'Pick the best model.',
          latestUserPromptPrefix: null,
          messageCount: 1,
          hasTools: false,
          stream: false,
          providerHints: {
            provider: null,
            providerOptions: null,
          },
        },
      },
    });
  });

  it('normalizes mirrored responses requests', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/responses',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: { 'x-kilocode-version': '1.2.3' },
        body: JSON.stringify({
          model: 'openai/gpt-5-mini',
          input: [
            { role: 'system', content: [{ type: 'input_text', text: 'Classify requests.' }] },
            { role: 'user', content: 'Which model should handle a fast code edit?' },
          ],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0.00000123,
      decision: null,
      classifierResult: {
        classification: mockClassification,
        normalized: {
          apiKind: 'responses',
          requestedModel: 'openai/gpt-5-mini',
          systemPromptPrefix: 'Classify requests.',
          userPromptPrefix: 'Which model should handle a fast code edit?',
          latestUserPromptPrefix: null,
          messageCount: 2,
          hasTools: false,
          stream: false,
          providerHints: {
            provider: null,
            providerOptions: null,
          },
        },
      },
    });
  });

  it('normalizes mirrored Anthropic messages requests', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/messages',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: { 'x-kilocode-version': '1.2.3' },
        body: JSON.stringify({
          model: 'anthropic/claude-opus-4',
          system: [{ type: 'text', text: 'Prefer high reasoning models.' }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Plan a migration.' }] }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0.00000123,
      decision: null,
      classifierResult: {
        classification: mockClassification,
        normalized: {
          apiKind: 'messages',
          requestedModel: 'anthropic/claude-opus-4',
          systemPromptPrefix: 'Prefer high reasoning models.',
          userPromptPrefix: 'Plan a migration.',
          latestUserPromptPrefix: null,
          messageCount: 1,
          hasTools: false,
          stream: false,
          providerHints: {
            provider: null,
            providerOptions: null,
          },
        },
      },
    });
  });

  it('returns a null classifier result for invalid mirrored request bodies', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: '{"model":',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0,
      decision: null,
      classifierResult: null,
    });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['unknown'],
      blobs: ['unknown', '', '', 'invalid_body', '', '', '', '', '', '', '', ''],
      doubles: [0, 0, -1, 0, 0, 9, 0],
    });
  });

  it('returns a null classifier result when the mirrored request has no requested model', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: JSON.stringify({ messages: [] }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0,
      decision: null,
      classifierResult: null,
    });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('logs fallback decisions with failure diagnostics', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    classifyNormalizedInput.mockResolvedValueOnce({
      ...mockClassifierResult,
      classification: {
        ...mockClassification,
        confidence: 0,
      },
      fallback: {
        reason: 'invalid_output',
        failureStage: 'invalid_schema',
        schemaIssueSummary: ['taskType:invalid_value'],
        topLevelKeys: ['minecraft'],
      },
    });

    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: 'task-123',
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cost: 0.00000123,
      classifierResult: {
        classification: {
          confidence: 0,
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = warnSpy.mock.calls[0] ?? [];
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'fallback:invalid_output',
      cacheHit: false,
      fallbackReason: 'invalid_output',
      classifierModel: 'google/gemini-2.5-flash-lite',
      requestedModel: 'anthropic/claude-sonnet-4',
      apiKind: 'chat_completions',
      sessionId: 'task-123',
      classifierDurationMs: expect.any(Number),
      classifierCostCredits: 0.00000123,
      confidence: 0,
      classifierFailureStage: 'invalid_schema',
      classifierSchemaIssueSummary: ['taskType:invalid_value'],
      classifierOutputTopLevelKeys: ['minecraft'],
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: expect.arrayContaining(['classified']),
      doubles: expect.arrayContaining([0]),
    });
  });

  it('returns a null classifier result when the classifier request fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    classifyNormalizedInput.mockRejectedValueOnce(
      new ClassifierRunError('Classifier model returned invalid classification', {
        cost: 0.00000123,
        classifierModel: 'google/gemini-2.5-flash-lite',
        failureStage: 'invalid_schema',
        schemaIssueSummary: ['taskType:invalid_value'],
        topLevelKeys: ['confidence'],
      })
    );

    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cost: 0.00000123,
      decision: null,
      classifierResult: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logMessage] = warnSpy.mock.calls[0] ?? [];
    expect(typeof logMessage).toBe('string');
    expect(JSON.parse(String(logMessage))).toMatchObject({
      event: 'auto_routing_decision',
      status: 'classifier_error:invalid_schema',
      cacheHit: false,
      reason: 'classifier_run_error',
      classifierModel: 'google/gemini-2.5-flash-lite',
      requestedModel: 'anthropic/claude-sonnet-4',
      apiKind: 'chat_completions',
      sessionId: null,
      classifierDurationMs: expect.any(Number),
      classifierCostCredits: 0.00000123,
      classifierFailureStage: 'invalid_schema',
      classifierSchemaIssueSummary: ['taskType:invalid_value'],
      classifierOutputTopLevelKeys: ['confidence'],
      error: 'Classifier model returned invalid classification',
      stack: expect.any(String),
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemini-2.5-flash-lite'],
      blobs: [
        'google/gemini-2.5-flash-lite',
        'anthropic/claude-sonnet-4',
        'chat_completions',
        'classifier_error:invalid_schema',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      doubles: [expect.any(Number), 0.00000123, -1, 1, 0, expect.any(Number), 0],
    });
  });

  it('rejects invalid JSON wrapper bodies', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: '{"path":',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects invalid wrapper payloads', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: '/chat/completions' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier payload' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects wrapper payloads without an explicit session id field', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        headers: {},
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [{ role: 'user', content: 'Pick the best model.' }],
        }),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier payload' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('rejects requests without the backend bearer token', async () => {
    const response = await request('/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        sessionId: null,
        headers: {},
        body: '{}',
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(classifyNormalizedInput).not.toHaveBeenCalled();
  });

  it('returns the configured classifier model', async () => {
    configGet.mockResolvedValueOnce('google/gemini-2.5-flash-lite');

    const response = await request('/admin/classifier-model', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'google/gemini-2.5-flash-lite',
      defaultModel: 'google/gemini-2.5-flash-lite',
    });
    expect(configGet).toHaveBeenCalledWith('classifier_model');
  });

  it('updates the configured classifier model', async () => {
    const response = await request('/admin/classifier-model', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite:free' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: 'google/gemini-2.5-flash-lite:free',
      defaultModel: 'google/gemini-2.5-flash-lite',
    });
    expect(configPut).toHaveBeenCalledWith('classifier_model', 'google/gemini-2.5-flash-lite:free');
  });

  it('rejects blank classifier model updates', async () => {
    const response = await request('/admin/classifier-model', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: '   ' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier model' });
    expect(configPut).not.toHaveBeenCalled();
  });

  it('queries classifier analytics for a selected period', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              total_requests: 10,
              classified_requests: 8,
              cached_requests: 6,
              classifier_errors: 1,
              invalid_requests: 1,
              total_cost_credits: 0.0000123,
              avg_duration_ms: 123.4,
              p95_duration_ms: 456.7,
              avg_confidence: 0.82,
              with_session_id: 9,
              unique_sessions: '7',
              requires_tools: 5,
              mirrored_has_tools: 6,
              avg_body_bytes: 2048,
            },
          ],
        }),
        { status: 200 }
      )
    );
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { status: 'classified', requests: 8 },
              { status: 'classifier_error:invalid_schema', requests: 1 },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ task_type: 'implementation', requests: 5, avg_confidence: 0.9 }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                task_type: 'implementation',
                subtask_type: 'feature_development',
                requests: 4,
                avg_confidence: 0.88,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ classifier_model: 'google/gemini-2.5-flash-lite', requests: 10 }],
          }),
          { status: 200 }
        )
      );

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      period: '24h',
      summary: {
        totalRequests: 10,
        classifiedRequests: 8,
        cachedRequests: 6,
        classifierErrors: 1,
        invalidRequests: 1,
        totalCostCredits: 0.0000123,
        avgDurationMs: 123.4,
        p95DurationMs: 456.7,
        avgConfidence: 0.82,
        withSessionId: 9,
        uniqueSessions: 7,
        requiresTools: 5,
        mirroredHasTools: 6,
        avgBodyBytes: 2048,
      },
      statusBreakdown: [
        { status: 'classified', requests: 8 },
        { status: 'classifier_error:invalid_schema', requests: 1 },
      ],
      taskTypeBreakdown: [{ taskType: 'implementation', requests: 5, avgConfidence: 0.9 }],
      taskSubtypeBreakdown: [
        {
          taskType: 'implementation',
          subtaskType: 'feature_development',
          requests: 4,
          avgConfidence: 0.88,
        },
      ],
      classifierModelBreakdown: [{ classifierModel: 'google/gemini-2.5-flash-lite', requests: 10 }],
    });
    expect(analyticsTokenGet).toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/analytics_engine/sql',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer analytics-token' },
      })
    );
  });

  it('returns empty analytics locally when the local Analytics Engine secret is absent', async () => {
    analyticsTokenGet.mockRejectedValueOnce(new Error('Secret "O11Y_CF_AE_API_TOKEN" not found'));

    const response = await localRequest('/admin/classifier-analytics?period=1h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      period: '1h',
      summary: {
        totalRequests: 0,
        classifiedRequests: 0,
        cachedRequests: 0,
        classifierErrors: 0,
        invalidRequests: 0,
        totalCostCredits: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        avgConfidence: 0,
        withSessionId: 0,
        uniqueSessions: 0,
        requiresTools: 0,
        mirroredHasTools: 0,
        avgBodyBytes: 0,
      },
      statusBreakdown: [],
      taskTypeBreakdown: [],
      taskSubtypeBreakdown: [],
      classifierModelBreakdown: [],
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('normalizes nullable Analytics Engine aggregate values', async () => {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                total_requests: 0,
                classified_requests: 0,
                classifier_errors: 0,
                invalid_requests: 0,
                total_cost_credits: 0,
                avg_duration_ms: null,
                p95_duration_ms: null,
                avg_confidence: null,
                with_session_id: 0,
                unique_sessions: 0,
                requires_tools: 0,
                mirrored_has_tools: 0,
                avg_body_bytes: null,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        avgDurationMs: 0,
        p95DurationMs: 0,
        avgConfidence: 0,
        avgBodyBytes: 0,
      },
    });
  });

  it('rejects malformed Analytics Engine responses', async () => {
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const response = await request('/admin/classifier-analytics?period=24h', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(500);
  });
});
