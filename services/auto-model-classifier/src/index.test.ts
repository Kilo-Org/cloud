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

  it('accepts mirrored gateway requests', async () => {
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
        body: '{"model":"auto"}',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
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
