import type { Context } from 'hono';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { ApproveResult, PairingCache } from '../pairing-cache';
import { isRecord } from '../pairing-cache';
import { getBearerToken } from './gateway';

function approveResponse(c: Context, result: ApproveResult): Response {
  const { statusHint, ...rest } = result;
  return c.json(rest, statusHint);
}

export function registerPairingRoutes(app: Hono, cache: PairingCache, expectedToken: string): void {
  app.use('/_kilo/pairing/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const token = getBearerToken(authHeader);
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/_kilo/pairing/channels', async c => {
    if (c.req.query('refresh') === 'true') {
      await cache.refreshChannelPairing();
    }
    return c.json(cache.getChannelPairing());
  });

  app.get('/_kilo/pairing/devices', async c => {
    if (c.req.query('refresh') === 'true') {
      await cache.refreshDevicePairing();
    }
    return c.json(cache.getDevicePairing());
  });

  app.post('/_kilo/pairing/channels/approve', async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body' }, 400);
    }

    const obj = isRecord(body) ? body : {};
    const channel = typeof obj['channel'] === 'string' ? obj['channel'] : undefined;
    const code = typeof obj['code'] === 'string' ? obj['code'] : undefined;
    if (!channel || !code) {
      return c.json({ success: false, message: 'Missing required fields: channel and code' }, 400);
    }

    return approveResponse(c, await cache.approveChannel(channel, code));
  });

  app.post('/_kilo/pairing/devices/approve', async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: 'Invalid request body' }, 400);
    }

    const obj = isRecord(body) ? body : {};
    const requestId = typeof obj.requestId === 'string' ? obj.requestId : undefined;
    if (!requestId) {
      return c.json({ success: false, message: 'Missing required field: requestId' }, 400);
    }

    return approveResponse(c, await cache.approveDevice(requestId));
  });
}
