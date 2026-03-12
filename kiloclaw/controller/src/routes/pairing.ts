import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { PairingCache } from '../pairing-cache';
import { getBearerToken } from './gateway';

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
    const refresh = c.req.query('refresh');
    if (refresh === 'true') {
      await cache.refreshChannelPairing();
    }
    const data = cache.getChannelPairing();
    return c.json(data);
  });

  app.get('/_kilo/pairing/devices', async (c) => {
    const refresh = c.req.query('refresh');
    if (refresh === 'true') {
      await cache.refreshDevicePairing();
    }
    const data = cache.getDevicePairing();
    return c.json(data);
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

    const { channel, code } = body as { channel?: string; code?: string };
    if (!channel || !code) {
      const msg = 'Missing required fields: channel and code';
      return c.json({ success: false, message: msg, error: msg }, 400);
    }

    const result = await cache.approveChannel(channel, code);
    const { statusHint, ...rest } = result;

    if (statusHint === 200) {
      return c.json(rest, 200);
    }
    return c.json({ ...rest, error: result.message }, statusHint);
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

    const { requestId } = body as { requestId?: string };
    if (!requestId) {
      const msg = 'Missing required field: requestId';
      return c.json({ success: false, message: msg, error: msg }, 400);
    }

    const result = await cache.approveDevice(requestId);
    const { statusHint, ...rest } = result;

    if (statusHint === 200) {
      return c.json(rest, 200);
    }
    return c.json({ ...rest, error: result.message }, statusHint);
  });
}
