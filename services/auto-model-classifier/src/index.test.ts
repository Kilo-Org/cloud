import { describe, expect, it } from 'vitest';
import { app } from './index';

const env = {
  BACKEND_AUTH_TOKEN: 'classifier-token',
} satisfies Env;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://auto-model-classifier.example.com${path}`, init, env);
}

describe('auto model classifier worker', () => {
  it('returns health without requiring classifier payload fields', async () => {
    const response = await request('/health', {
      headers: { authorization: 'Bearer classifier-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'auto-model-classifier',
    });
  });

  it('normalizes mirrored chat completion requests', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
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
      ok: true,
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
    });
  });

  it('normalizes mirrored responses requests', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/responses',
        receivedAt: '2026-06-09T10:00:00.000Z',
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
      ok: true,
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
    });
  });

  it('normalizes mirrored Anthropic messages requests', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/messages',
        receivedAt: '2026-06-09T10:00:00.000Z',
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
      ok: true,
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
    });
  });

  it('rejects mirrored requests with invalid JSON bodies', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        headers: {},
        body: '{"model":',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid mirrored request body' });
  });

  it('rejects mirrored requests without a requested model', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer classifier-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        headers: {},
        body: JSON.stringify({ messages: [] }),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid classifier body' });
  });

  it('rejects requests without the backend bearer token', async () => {
    const response = await request('/classify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/chat/completions',
        receivedAt: '2026-06-09T10:00:00.000Z',
        headers: {},
        body: '{}',
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });
});
