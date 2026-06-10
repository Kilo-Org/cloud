import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';

const classifyNormalizedInput = vi.hoisted(() => vi.fn());

vi.mock('./model-classifier', () => ({ classifyNormalizedInput }));

const writeDataPoint = vi.fn();

const env = {
  INTERNAL_API_SECRET_PROD: {
    get: async () => 'classifier-token',
  },
  AUTO_ROUTING_CLASSIFIER_METRICS: {
    writeDataPoint,
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
  classifierModel: 'google/gemma-4-31b-it',
  classification: mockClassification,
};

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://auto-routing.example.com${path}`, init, env);
}

describe('auto routing worker', () => {
  beforeEach(() => {
    classifyNormalizedInput.mockReset();
    classifyNormalizedInput.mockResolvedValue(mockClassifierResult);
    writeDataPoint.mockReset();
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
    expect(classifyNormalizedInput).toHaveBeenCalledWith(env, {
      apiKind: 'chat_completions',
      requestedModel: 'anthropic/claude-sonnet-4',
      systemPromptPrefix: 'You classify auto model routing requests.',
      userPromptPrefix: 'Pick the best model for this request.',
      messageCount: 3,
      hasTools: true,
      stream: true,
      providerHints: {
        provider: { order: ['anthropic'] },
        providerOptions: { openrouter: { sort: 'price', apiKey: '[REDACTED]' } },
      },
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['google/gemma-4-31b-it'],
      blobs: [
        'google/gemma-4-31b-it',
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
      doubles: [expect.any(Number), 0.00000123, 0.82, 3, 1, expect.any(Number)],
    });
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
      doubles: [0, 0, -1, 0, 0, 9],
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

  it('returns a null classifier result when the classifier request fails', async () => {
    classifyNormalizedInput.mockRejectedValueOnce(new Error('OpenRouter unavailable'));

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
      classifierResult: null,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['unknown'],
      blobs: [
        'unknown',
        'anthropic/claude-sonnet-4',
        'chat_completions',
        'classifier_error',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      doubles: [expect.any(Number), 0, -1, 1, 0, expect.any(Number)],
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
});
