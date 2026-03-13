import type { Context } from 'hono';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { ApproveResult, PairingCache } from '../pairing-cache';
import { getBearerToken } from './gateway';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function approveResponse(c: Context, result: ApproveResult): Response {
  const { statusHint, ...rest } = result;
  if (result.success) {
    return c.json(rest, statusHint);
  }
  return c.json({ ...rest, error: result.message }, statusHint);
}

export function registerPairingRoutes(
  app: Hono,
  cache: PairingCache,
  expectedToken: string
): void {
  app.use('/_kilo/pairing/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const token = getBearerToken(authHeader);
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/_kilo/pairing/channels', async (c) => {
    if (c.req.query('refresh') === 'true') {
      try {
        await cache.refreshChannelPairing();
      } catch (err) {
        console.error('[pairing-routes] channel refresh failed:', err);
      }
    }
    return c.json(cache.getChannelPairing());
  });

  app.get('/_kilo/pairing/devices', async (c) => {
    if (c.req.query('refresh') === 'true') {
      try {
        await cache.refreshDevicePairing();
      } catch (err) {
        console.error('[pairing-routes] device refresh failed:', err);
      }
    }
    return c.json(cache.getDevicePairing());
  });

  app.post('/_kilo/pairing/channels/approve', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, message: 'Invalid request body', error: 'Invalid request body' },
        400
      );
    }

    const obj = isRecord(body) ? body : {};
    const channel = typeof obj['channel'] === 'string' ? obj['channel'] : undefined;
    const code = typeof obj['code'] === 'string' ? obj['code'] : undefined;
    if (!channel || !code) {
      const msg = 'Missing required fields: channel and code';
      return c.json({ success: false, message: msg, error: msg }, 400);
    }

    return approveResponse(c, await cache.approveChannel(channel, code));
  });

  app.post('/_kilo/pairing/devices/approve', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, message: 'Invalid request body', error: 'Invalid request body' },
        400
      );
    }

    const obj = isRecord(body) ? body : {};
    const requestId = typeof obj.requestId === 'string' ? obj.requestId : undefined;
    if (!requestId) {
      const msg = 'Missing required field: requestId';
      return c.json({ success: false, message: msg, error: msg }, 400);
    }

    return approveResponse(c, await cache.approveDevice(requestId));
  });
}
