import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { isValidImageTag } from '../lib/image-tag-validation';
import { GoogleCredentialsSchema } from '../schemas/instance-config';
import { instrumented } from '../middleware/analytics';

/**
 * API routes
 * - /api/admin/* - Admin API routes (user-facing, JWT auth, operations via DO RPC)
 */
const api = new Hono<AppEnv>();

/**
 * Resolve the user's KiloClawInstance DO stub from the authenticated userId.
 */
function resolveStub(c: { get: (key: 'userId') => string; env: AppEnv['Bindings'] }) {
  const userId = c.get('userId');
  return c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));
}

/**
 * Admin API routes -- all operations go through the KiloClawInstance DO.
 */
const adminApi = new Hono<AppEnv>();

// GET /api/admin/storage - Removed (R2 replaced by Fly Volumes)
adminApi.get('/storage', c =>
  instrumented(c, 'GET /api/admin/storage', async () =>
    c.json({ error: 'Storage sync has been removed. Data now persists via Fly Volumes.' }, 410)
  )
);

// POST /api/admin/storage/sync - Removed (R2 replaced by Fly Volumes)
adminApi.post('/storage/sync', c =>
  instrumented(c, 'POST /api/admin/storage/sync', async () =>
    c.json({ error: 'Storage sync has been removed. Data now persists via Fly Volumes.' }, 410)
  )
);

// POST /api/admin/machine/restart - Restart the Fly Machine via the DO
adminApi.post('/machine/restart', c =>
  instrumented(c, 'POST /api/admin/machine/restart', async () => {
    const stub = resolveStub(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawTag = typeof body.imageTag === 'string' ? body.imageTag : undefined;

    if (rawTag && !isValidImageTag(rawTag)) {
      return c.json({ success: false, error: 'Invalid image tag format' }, 400);
    }

    const imageTag = rawTag;
    const result = await stub.restartMachine(imageTag ? { imageTag } : undefined);

    if (result.success) {
      return c.json({
        success: true,
        message: imageTag
          ? `Machine restarting with image tag: ${imageTag}...`
          : 'Machine restarting with updated configuration...',
      });
    } else {
      return c.json({ success: false, error: result.error }, 500);
    }
  })
);

// TODO: Remove after frontend rollout to /api/admin/machine/restart
// POST /api/admin/gateway/restart - Backward-compat alias for machine restart
adminApi.post('/gateway/restart', c =>
  instrumented(c, 'POST /api/admin/gateway/restart', async () => {
    const stub = resolveStub(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawTag = typeof body.imageTag === 'string' ? body.imageTag : undefined;

    if (rawTag && !isValidImageTag(rawTag)) {
      return c.json({ success: false, error: 'Invalid image tag format' }, 400);
    }

    const imageTag = rawTag;
    const result = await stub.restartMachine(imageTag ? { imageTag } : undefined);

    if (result.success) {
      return c.json({
        success: true,
        message: imageTag
          ? `Machine restarting with image tag: ${imageTag}...`
          : 'Machine restarting with updated configuration...',
      });
    } else {
      return c.json({ success: false, error: result.error }, 500);
    }
  })
);

// Isolate-level cache: shared across requests within the same CF Worker isolate
// but evicted when the isolate is recycled. Not persistent — just avoids
// re-deriving the public key on every request within a single isolate lifetime.
let cachedPublicKeyPem: string | null = null;
let cachedForPrivateKey: string | null = null;

// GET /api/admin/public-key - RSA public key for encrypting secrets
// The google-setup container fetches this to encrypt Google OAuth credentials.
adminApi.get('/public-key', c =>
  instrumented(c, 'GET /api/admin/public-key', async () => {
    const privateKeyPem = c.env.AGENT_ENV_VARS_PRIVATE_KEY;
    if (!privateKeyPem) {
      return c.json({ error: 'Encryption not configured' }, 503);
    }

    try {
      // Return cached public key if derived from the same private key
      if (cachedPublicKeyPem && cachedForPrivateKey === privateKeyPem) {
        return c.json({ publicKey: cachedPublicKeyPem });
      }

      const { createPublicKey } = await import('crypto');
      const publicKey = createPublicKey({ key: privateKeyPem, format: 'pem' });
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

      cachedPublicKeyPem = publicKeyPem;
      cachedForPrivateKey = privateKeyPem;

      return c.json({ publicKey: publicKeyPem });
    } catch (err) {
      console.error('[api] Failed to derive public key:', err);
      return c.json({ error: 'Failed to derive public key' }, 500);
    }
  })
);

// GET /api/admin/google-credentials - Check Google connection status
adminApi.get('/google-credentials', c =>
  instrumented(c, 'GET /api/admin/google-credentials', async () => {
    const stub = resolveStub(c);
    try {
      const status = await stub.getStatus();
      return c.json({ googleConnected: status.googleConnected ?? false }, 200);
    } catch (err) {
      console.error('[api] google-credentials status failed:', err);
      return c.json({ error: 'Failed to check Google credentials status' }, 500);
    }
  })
);

// POST /api/admin/google-credentials - Store encrypted Google credentials
adminApi.post('/google-credentials', c =>
  instrumented(c, 'POST /api/admin/google-credentials', async () => {
    const stub = resolveStub(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Malformed JSON body' }, 400);
    }

    const parsed = GoogleCredentialsSchema.safeParse(
      typeof body === 'object' && body !== null && 'googleCredentials' in body
        ? (body as Record<string, unknown>).googleCredentials
        : body
    );
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors }, 400);
    }

    try {
      const result = await stub.updateGoogleCredentials(parsed.data);
      return c.json(result, 200);
    } catch (err) {
      console.error('[api] google-credentials failed:', err);
      return c.json({ error: 'Failed to store Google credentials' }, 500);
    }
  })
);

// DELETE /api/admin/google-credentials - Clear Google credentials
adminApi.delete('/google-credentials', c =>
  instrumented(c, 'DELETE /api/admin/google-credentials', async () => {
    const stub = resolveStub(c);
    try {
      const result = await stub.clearGoogleCredentials();
      return c.json(result, 200);
    } catch (err) {
      console.error('[api] google-credentials delete failed:', err);
      return c.json({ error: 'Failed to clear Google credentials' }, 500);
    }
  })
);

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
