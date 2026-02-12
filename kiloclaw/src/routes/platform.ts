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
import { withDORetry } from '../util/do-retry';
import { deriveGatewayToken } from '../auth/gateway-token';
import type { z } from 'zod';

const platform = new Hono<AppEnv>();

/**
 * Create a fresh KiloClawInstance DO stub for a userId.
 * Returns a factory (not the stub itself) so withDORetry can get a fresh stub per attempt.
 */
function instanceStubFactory(env: AppEnv['Bindings'], userId: string) {
  return () => env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId));
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
    const provision = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.provision(userId, { envVars, encryptedSecrets, channels }),
      'provision'
    );
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
    await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.start(),
      'start'
    );
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
    await withDORetry(instanceStubFactory(c.env, result.data.userId), stub => stub.stop(), 'stop');
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
    await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.destroy(result.data.deleteData),
      'destroy'
    );
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
    const status = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getStatus(),
      'getStatus'
    );
    return c.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] status failed:', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/platform/gateway-token?userId=...
// Returns the derived gateway token for a user's sandbox. The Next.js
// dashboard calls this so it never needs GATEWAY_TOKEN_SECRET directly.
platform.get('/gateway-token', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json({ error: 'GATEWAY_TOKEN_SECRET is not configured' }, 503);
  }

  try {
    const status = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getStatus(),
      'getStatus'
    );

    if (!status.sandboxId) {
      return c.json({ error: 'Instance not provisioned' }, 404);
    }

    const gatewayToken = await deriveGatewayToken(status.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
    return c.json({ gatewayToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[platform] gateway-token failed:', message);
    return c.json({ error: message }, 500);
  }
});

export { platform };
