import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('user-data-export worker', () => {
  it('keeps health public and rejects missing or incorrect internal API keys', async () => {
    const health = await SELF.fetch('https://worker.local/health');
    expect(health.status).toBe(200);
    const denied = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      body: '{}',
    });
    expect(denied.status).toBe(401);
    const incorrectKey = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { 'x-internal-api-key': 'wrong-token' },
      body: '{}',
    });
    expect(incorrectKey.status).toBe(401);
  });

  it('accepts the standard internal API key header', async () => {
    const response = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { 'x-internal-api-key': 'test-token' },
      body: '{}',
    });

    expect(response.status).toBe(400);
  });
});
