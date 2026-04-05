import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerPairingRoutes } from './pairing';
import type { PairingCache } from '../pairing-cache';

function createMockCache(): PairingCache {
  return {
    getChannelPairing: vi.fn(() => ({
      requests: [{ code: 'ABC123', id: 'req-1', channel: 'telegram' }],
      lastUpdated: '2026-03-12T00:00:00.000Z',
    })),
    getDevicePairing: vi.fn(() => ({
      requests: [{ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deviceId: 'dev-1' }],
      lastUpdated: '2026-03-12T00:00:00.000Z',
    })),
    refreshChannelPairing: vi.fn(async () => undefined),
    refreshDevicePairing: vi.fn(async () => undefined),
    approveChannel: vi.fn(async () => ({
      success: true as const,
      message: 'Pairing approved',
      statusHint: 200 as const,
    })),
    approveDevice: vi.fn(async () => ({
      success: true as const,
      message: 'Device approved',
      statusHint: 200 as const,
    })),
    onPairingLogLine: vi.fn(),
    start: vi.fn(() => undefined),
    cleanup: vi.fn(),
  };
}

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token = 'test-token'): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function createApp(cache: PairingCache): Hono {
  const app = new Hono();
  registerPairingRoutes(app, cache, 'test-token');
  return app;
}

describe('/_kilo/pairing routes', () => {
  describe('auth', () => {
    it('returns 401 without token', async () => {
      const app = createApp(createMockCache());

      const resp = await app.request('/_kilo/pairing/channels');
      expect(resp.status).toBe(401);
      expect(await resp.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with wrong token', async () => {
      const app = createApp(createMockCache());

      const resp = await app.request('/_kilo/pairing/channels', {
        headers: authHeaders('wrong-token'),
      });
      expect(resp.status).toBe(401);
      expect(await resp.json()).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('GET /_kilo/pairing/channels', () => {
    it('returns cache data with 200', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels', {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({
        requests: [{ code: 'ABC123', id: 'req-1', channel: 'telegram' }],
        lastUpdated: '2026-03-12T00:00:00.000Z',
      });
      expect(cache.refreshChannelPairing).not.toHaveBeenCalled();
    });

    it('calls refreshChannelPairing when refresh=true', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels?refresh=true', {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      expect(cache.refreshChannelPairing).toHaveBeenCalledOnce();
    });

    it('does not refresh when refresh param is absent', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      await app.request('/_kilo/pairing/channels', { headers: authHeaders() });
      expect(cache.refreshChannelPairing).not.toHaveBeenCalled();
    });
  });

  describe('GET /_kilo/pairing/devices', () => {
    it('returns cache data with 200', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices', {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({
        requests: [{ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deviceId: 'dev-1' }],
        lastUpdated: '2026-03-12T00:00:00.000Z',
      });
      expect(cache.refreshDevicePairing).not.toHaveBeenCalled();
    });

    it('calls refreshDevicePairing when refresh=true', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices?refresh=true', {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      expect(cache.refreshDevicePairing).toHaveBeenCalledOnce();
    });
  });

  describe('POST /_kilo/pairing/channels/approve', () => {
    it('returns 200 on success', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'telegram', code: 'ABC123' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ success: true, message: 'Pairing approved' });
      expect(cache.approveChannel).toHaveBeenCalledWith('telegram', 'ABC123');
    });

    it('returns 400 on validation failure', async () => {
      const cache = createMockCache();
      vi.mocked(cache.approveChannel).mockResolvedValueOnce({
        success: false,
        message: 'Invalid channel name',
        statusHint: 400,
      });
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'INVALID!!!', code: 'ABC123' }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Invalid channel name',
      });
    });

    it('returns 500 on CLI failure', async () => {
      const cache = createMockCache();
      vi.mocked(cache.approveChannel).mockResolvedValueOnce({
        success: false,
        message: 'Command failed',
        statusHint: 500,
      });
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'telegram', code: 'ABC123' }),
      });
      expect(resp.status).toBe(500);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Command failed',
      });
    });

    it('returns 400 with missing body fields', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'telegram' }),
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { success: boolean; message: string };
      expect(body.success).toBe(false);
      expect(body.message).toContain('Missing required fields');
    });

    it('returns 400 with invalid JSON body', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: 'not json',
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Invalid request body',
      });
    });
  });

  describe('POST /_kilo/pairing/devices/approve', () => {
    it('returns 200 on success', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toEqual({ success: true, message: 'Device approved' });
      expect(cache.approveDevice).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('returns 400 on validation failure', async () => {
      const cache = createMockCache();
      vi.mocked(cache.approveDevice).mockResolvedValueOnce({
        success: false,
        message: 'Invalid request ID',
        statusHint: 400,
      });
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ requestId: 'not-a-uuid' }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Invalid request ID',
      });
    });

    it('returns 500 on CLI failure', async () => {
      const cache = createMockCache();
      vi.mocked(cache.approveDevice).mockResolvedValueOnce({
        success: false,
        message: 'Command failed',
        statusHint: 500,
      });
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      });
      expect(resp.status).toBe(500);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Command failed',
      });
    });

    it('returns 400 with missing requestId', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { success: boolean; message: string };
      expect(body.success).toBe(false);
      expect(body.message).toContain('Missing required field');
    });

    it('returns 400 with invalid JSON body', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/devices/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: 'not json',
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body).toEqual({
        success: false,
        message: 'Invalid request body',
      });
    });
  });

  describe('response shapes', () => {
    it('list response has requests and lastUpdated fields', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels', {
        headers: authHeaders(),
      });
      const body = (await resp.json()) as { requests: unknown[]; lastUpdated: string };
      expect(body).toHaveProperty('requests');
      expect(body).toHaveProperty('lastUpdated');
      expect(Array.isArray(body.requests)).toBe(true);
      expect(typeof body.lastUpdated).toBe('string');
    });

    it('approve success response has success and message fields', async () => {
      const cache = createMockCache();
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'telegram', code: 'ABC123' }),
      });
      const body = await resp.json();
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('message');
      expect(body).not.toHaveProperty('error');
    });

    it('approve error response has success and message fields', async () => {
      const cache = createMockCache();
      vi.mocked(cache.approveChannel).mockResolvedValueOnce({
        success: false,
        message: 'Invalid channel name',
        statusHint: 400,
      });
      const app = createApp(cache);

      const resp = await app.request('/_kilo/pairing/channels/approve', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ channel: 'BAD', code: 'ABC123' }),
      });
      const body = (await resp.json()) as { success: boolean; message: string };
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('message');
      expect(body).not.toHaveProperty('error');
    });
  });
});
