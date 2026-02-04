import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deliverCallbackJob } from './delivery.js';
import type { CallbackTarget, ExecutionCallbackPayload } from './types.js';

const mockPayload: ExecutionCallbackPayload = {
  sessionId: 'test-session',
  cloudAgentSessionId: 'test-session',
  executionId: 'test-execution',
  status: 'completed',
};

describe('deliverCallbackJob', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  describe('retry behavior based on attempts', () => {
    it('should retry on first attempt (attempts=1) with 500 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.delaySeconds).toBe(60); // base * 2^(attempts-1)
      }
    });

    it('should retry on second attempt (attempts=2) with 500 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 2);

      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.delaySeconds).toBe(120); // base * 2^(attempts-1)
      }
    });

    it('should retry on third attempt (attempts=3) with 500 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 3);

      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.delaySeconds).toBe(240); // base * 2^(attempts-1)
      }
    });

    it('should fail on fifth attempt (attempts=5) with 500 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 5);

      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.error).toContain('5 attempts');
      }
    });

    it('should retry on 429 (rate limited)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('retry');
    });

    it('should NOT retry on 4xx errors (except 429)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('failed');
    });

    it('should NOT retry on 404 errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('failed');
    });

    it('should retry on 502 (bad gateway)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('retry');
    });

    it('should retry on 503 (service unavailable)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('retry');
    });
  });

  describe('successful delivery', () => {
    it('should succeed on 200 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('success');
    });

    it('should succeed on 201 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 201 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('success');
    });

    it('should succeed on 204 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('success');
    });

    it('should send correct payload to fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = mockFetch;
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      await deliverCallbackJob(target, mockPayload, 1);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/callback',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(mockPayload),
        })
      );
    });

    it('should include custom headers in request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = mockFetch;
      const target: CallbackTarget = {
        url: 'https://example.com/callback',
        headers: { Authorization: 'Bearer token123' },
      };

      await deliverCallbackJob(target, mockPayload, 1);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/callback',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer token123',
          }),
        })
      );
    });
  });

  describe('network errors', () => {
    it('should retry on network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 1);

      expect(result.type).toBe('retry');
    });

    it('should fail after max attempts on persistent network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const target: CallbackTarget = { url: 'https://example.com/callback' };

      const result = await deliverCallbackJob(target, mockPayload, 5);

      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.error).toContain('Network error');
      }
    });
  });
});
