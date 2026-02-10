/**
 * Platform API routes -- backend-to-backend only (x-internal-api-key).
 *
 * All routes are thin RPC wrappers around KiloClawInstance DO methods.
 * The route handler's only job: validate input, get DO stub, call method.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import {
  ProvisionRequestSchema,
  UserIdRequestSchema,
  DestroyRequestSchema,
} from '../schemas/instance-config';
import type { z } from 'zod';

const platform = new Hono<AppEnv>();

/**
 * Resolve the KiloClawInstance DO stub for a userId.
 */
function getInstanceStub(env: AppEnv['Bindings'], userId: string) {
  return env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId));
}

/**
 * Safely parse JSON body through a zod schema.
 * Returns 400 with a consistent error shape on malformed JSON or validation failure.
 */
async function parseBody<T extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: T
): Promise<{ data: z.infer<T> } | { error: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { error: c.json({ error: 'Malformed JSON body' }, 400) };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      error: c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400),
    };
  }

  return { data: parsed.data };
}

// POST /api/platform/provision
platform.post('/provision', async c => {
  const result = await parseBody(c, ProvisionRequestSchema);
  if ('error' in result) return result.error;

  const { userId, envVars, encryptedSecrets, channels } = result.data;

  try {
    const instance = getInstanceStub(c.env, userId);
    const provision = await instance.provision(userId, { envVars, encryptedSecrets, channels });
    return c.json(provision, 201);
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
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const instance = getInstanceStub(c.env, result.data.userId);
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
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const instance = getInstanceStub(c.env, result.data.userId);
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
  const result = await parseBody(c, DestroyRequestSchema);
  if ('error' in result) return result.error;

  try {
    const instance = getInstanceStub(c.env, result.data.userId);
    await instance.destroy(result.data.deleteData);
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
