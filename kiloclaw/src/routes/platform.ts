/**
 * Platform API routes -- backend-to-backend only (x-internal-api-key).
 *
 * All routes are thin RPC wrappers around KiloClawInstance DO methods.
 * The route handler's only job: validate input, get DO stub, call method.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  ProvisionRequestSchema,
  UserIdRequestSchema,
  DestroyRequestSchema,
} from '../schemas/instance-config';

const platform = new Hono<AppEnv>();

/**
 * Resolve the KiloClawInstance DO stub for a userId.
 */
function getInstanceStub(env: AppEnv['Bindings'], userId: string) {
  return env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId));
}

// POST /api/platform/provision
platform.post('/provision', async c => {
  const parsed = ProvisionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { userId, envVars, encryptedSecrets, channels } = parsed.data;

  try {
    const instance = getInstanceStub(c.env, userId);
    const result = await instance.provision(userId, { envVars, encryptedSecrets, channels });
    return c.json(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] provision failed:', message);
    if (message.includes('duplicate key') || message.includes('unique constraint')) {
      return c.json({ error: 'User already has an active instance' }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

// POST /api/platform/start
platform.post('/start', async c => {
  const parsed = UserIdRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'userId is required' }, 400);
  }

  try {
    const instance = getInstanceStub(c.env, parsed.data.userId);
    await instance.start();
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] start failed:', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/platform/stop
platform.post('/stop', async c => {
  const parsed = UserIdRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'userId is required' }, 400);
  }

  try {
    const instance = getInstanceStub(c.env, parsed.data.userId);
    await instance.stop();
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] stop failed:', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/platform/destroy
platform.post('/destroy', async c => {
  const parsed = DestroyRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'userId is required' }, 400);
  }

  try {
    const instance = getInstanceStub(c.env, parsed.data.userId);
    await instance.destroy(parsed.data.deleteData);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] destroy failed:', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/platform/status?userId=...
platform.get('/status', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const instance = getInstanceStub(c.env, userId);
    const status = await instance.getStatus();
    return c.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] status failed:', message);
    return c.json({ error: message }, 500);
  }
});

export { platform };
