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
  ChannelsPatchSchema,
} from '../schemas/instance-config';
import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
} from '../schemas/image-version';
import { listAllVersions, updateTagIndex } from '../lib/image-version';
import { upsertCatalogVersion } from '../lib/catalog-registration';
import { z } from 'zod';
import { withDORetry } from '@kilocode/worker-utils';
import { deriveGatewayToken } from '../auth/gateway-token';

const KiloCodeConfigPatchSchema = z.object({
  userId: z.string().min(1),
  kilocodeApiKey: z.string().nullable().optional(),
  kilocodeApiKeyExpiresAt: z.string().nullable().optional(),
  kilocodeDefaultModel: z
    .string()
    .regex(
      /^kilocode\/[^/]+\/.+$/,
      'kilocodeDefaultModel must start with kilocode/ and include a provider'
    )
    .nullable()
    .optional(),
});

const platform = new Hono<AppEnv>();

/**
 * Create a fresh KiloClawInstance DO stub for a userId.
 * Returns a factory (not the stub itself) so withDORetry can get a fresh stub per attempt.
 */
function instanceStubFactory(env: AppEnv['Bindings'], userId: string) {
  return () => env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId));
}

function statusCodeFromError(err: unknown): number {
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    const status = (err as { status: number }).status;
    if (status >= 400 && status < 600) return status;
  }
  return 500;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Safe error messages that can be returned to callers without leaking internals.
 * All other error messages are replaced with a generic "Internal error" response.
 * The raw error is always logged via console.error for Sentry/debugging.
 */
const SAFE_ERROR_PREFIXES = [
  'Instance is not ', // e.g. "Instance is not running", "Instance is not provisioned"
  'User already has an ', // duplicate provision
  'Gateway controller ', // already sanitized at DO level
];

function sanitizeError(err: unknown, operation: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);

  // Log the full error for Sentry/debugging — this never reaches the caller
  console.error(`[platform] ${operation} failed:`, raw);

  // Allow known-safe messages through
  if (SAFE_ERROR_PREFIXES.some(prefix => raw.startsWith(prefix))) {
    return { message: raw, status };
  }

  return { message: `${operation} failed`, status };
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

  const {
    userId,
    envVars,
    encryptedSecrets,
    channels,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel,
    machineSize,
    region,
  } = result.data;

  try {
    const provision = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub =>
        stub.provision(userId, {
          envVars,
          encryptedSecrets,
          channels,
          kilocodeApiKey,
          kilocodeApiKeyExpiresAt,
          kilocodeDefaultModel,
          machineSize,
          region,
        }),
      'provision'
    );
    return c.json(provision, 201);
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    if (raw.includes('duplicate key') || raw.includes('unique constraint')) {
      console.error('[platform] provision failed: duplicate instance');
      return c.json({ error: 'User already has an active instance' }, 409);
    }
    const { message, status } = sanitizeError(err, 'provision');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/kilocode-config
platform.patch('/kilocode-config', async c => {
  const result = await parseBody(c, KiloCodeConfigPatchSchema);
  if ('error' in result) return result.error;

  const { userId, kilocodeApiKey, kilocodeApiKeyExpiresAt, kilocodeDefaultModel } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub =>
        stub.updateKiloCodeConfig({
          kilocodeApiKey,
          kilocodeApiKeyExpiresAt,
          kilocodeDefaultModel,
        }),
      'updateKiloCodeConfig'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilocode-config patch');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/channels
platform.patch('/channels', async c => {
  const result = await parseBody(c, ChannelsPatchSchema);
  if ('error' in result) return result.error;

  const { userId, channels } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateChannels(channels),
      'updateChannels'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'channels patch');
    return jsonError(message, status);
  }
});

// GET /api/platform/pairing?userId=...&refresh=true
platform.get('/pairing', async c => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.listPairingRequests(forceRefresh),
      'listPairingRequests'
    );
    return c.json(pairing, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'pairing list');
    return jsonError(message, status);
  }
});

// POST /api/platform/pairing/approve
const PairingApproveSchema = z.object({
  userId: z.string().min(1),
  channel: z.string().min(1),
  code: z.string().min(1),
});

platform.post('/pairing/approve', async c => {
  const result = await parseBody(c, PairingApproveSchema);
  if ('error' in result) return result.error;

  const { userId, channel, code } = result.data;

  try {
    const approved = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.approvePairingRequest(channel, code),
      'approvePairingRequest'
    );
    return c.json(approved, approved.success ? 200 : 500);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'pairing approve');
    return jsonError(message, status);
  }
});

// GET /api/platform/device-pairing?userId=...&refresh=true
platform.get('/device-pairing', async c => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.listDevicePairingRequests(forceRefresh),
      'listDevicePairingRequests'
    );
    return c.json(pairing, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'device pairing list');
    return jsonError(message, status);
  }
});

// POST /api/platform/device-pairing/approve
const DevicePairingApproveSchema = z.object({
  userId: z.string().min(1),
  requestId: z.string().uuid(),
});

platform.post('/device-pairing/approve', async c => {
  const result = await parseBody(c, DevicePairingApproveSchema);
  if ('error' in result) return result.error;

  const { userId, requestId } = result.data;

  try {
    const approved = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.approveDevicePairingRequest(requestId),
      'approveDevicePairingRequest'
    );
    return c.json(approved, approved.success ? 200 : 500);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'device pairing approve');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway/status?userId=...
platform.get('/gateway/status', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const gatewayStatus = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getGatewayProcessStatus(),
      'getGatewayProcessStatus'
    );
    return c.json(gatewayStatus, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway status');
    return jsonError(message, status);
  }
});

// GET /api/platform/controller-version?userId=...
platform.get('/controller-version', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getControllerVersion(),
      'getControllerVersion'
    );
    // null means the controller is too old to have /_kilo/version
    return c.json(result ?? { version: null, commit: null }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = statusCodeFromError(err);
    console.error(`[platform] controller version failed: ${message} status=${status}`);
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/start
platform.post('/gateway/start', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.startGatewayProcess(),
      'startGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway start');
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/stop
platform.post('/gateway/stop', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.stopGatewayProcess(),
      'stopGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway stop');
    return jsonError(message, status);
  }
});

// POST /api/platform/gateway/restart
platform.post('/gateway/restart', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.restartGatewayProcess(),
      'restartGatewayProcess'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gateway restart');
    return jsonError(message, status);
  }
});

// POST /api/platform/config/restore
const ConfigRestoreSchema = z.object({
  userId: z.string().min(1),
  version: z.literal('base'),
});

platform.post('/config/restore', async c => {
  const result = await parseBody(c, ConfigRestoreSchema);
  if ('error' in result) return result.error;

  const { userId, version } = result.data;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.restoreConfig(version),
      'restoreConfig'
    );
    return c.json(response, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = statusCodeFromError(err);
    console.error('[platform] config restore failed:', message);
    return jsonError(message, status);
  }
});

// POST /api/platform/doctor
platform.post('/doctor', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    const doctor = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.runDoctor(),
      'runDoctor'
    );
    return c.json(doctor, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor');
    return jsonError(message, status);
  }
});

// POST /api/platform/start
platform.post('/start', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  try {
    await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.start(result.data.userId),
      'start'
    );
    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'start');
    return jsonError(message, status);
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
    const { message, status } = sanitizeError(err, 'stop');
    return jsonError(message, status);
  }
});

// POST /api/platform/destroy
platform.post('/destroy', async c => {
  const result = await parseBody(c, DestroyRequestSchema);
  if ('error' in result) return result.error;

  try {
    await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.destroy(),
      'destroy'
    );
    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'destroy');
    return jsonError(message, status);
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
    const { message, status } = sanitizeError(err, 'status');
    return jsonError(message, status);
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
    const { message, status } = sanitizeError(err, 'gateway-token');
    return jsonError(message, status);
  }
});

// GET /api/platform/volume-snapshots?userId=...
// Returns the list of Fly volume snapshots for the user's instance.
platform.get('/volume-snapshots', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const snapshots = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.listVolumeSnapshots(),
      'listVolumeSnapshots'
    );
    return c.json({ snapshots });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'volume-snapshots');
    return jsonError(message, status);
  }
});

// GET /api/platform/versions
// Lists all registered image versions from KV.
// Used by admin triggerSync for reconciliation/backfill.
platform.get('/versions', async c => {
  try {
    const versions = await listAllVersions(c.env.KV_CLAW_CACHE);
    return c.json(versions);
  } catch (err) {
    console.error('[platform] Failed to list versions:', err);
    return c.json({ error: 'Failed to list versions' }, 500);
  }
});

// POST /api/platform/publish-image-version
// Manual fallback for publishing/correcting version entries.
// Primary registration path is worker self-registration on deploy.
const PublishImageVersionSchema = z.object({
  openclawVersion: z.string().min(1),
  variant: z.string().min(1).default('default'),
  imageTag: z.string().min(1),
  imageDigest: z.string().nullable().optional(),
  // Set to false when backfilling older versions to avoid overwriting the latest pointer.
  setLatest: z.boolean().optional().default(true),
});

platform.post('/publish-image-version', async c => {
  const result = await parseBody(c, PublishImageVersionSchema);
  if ('error' in result) return result.error;

  const { openclawVersion, variant, imageTag, imageDigest, setLatest } = result.data;

  if (openclawVersion === 'latest') {
    return c.json({ error: '"latest" is reserved and cannot be used as a version' }, 400);
  }

  const entry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest: imageDigest ?? null,
    publishedAt: new Date().toISOString(),
  };

  // Validate against schema
  const parsed = ImageVersionEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return c.json({ error: 'Invalid version entry', details: parsed.error.flatten() }, 400);
  }

  // Write the versioned key; optionally update the latest pointer
  const serialized = JSON.stringify(parsed.data);
  const writes: Promise<void>[] = [
    c.env.KV_CLAW_CACHE.put(imageVersionKey(openclawVersion, variant), serialized),
  ];
  if (setLatest) {
    writes.push(c.env.KV_CLAW_CACHE.put(imageVersionLatestKey(variant), serialized));
  }
  await Promise.all(writes);

  // Maintain KV tag index
  await updateTagIndex(c.env.KV_CLAW_CACHE, imageTag);

  // Write to Postgres catalog (best-effort)
  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (connectionString) {
    try {
      await upsertCatalogVersion(connectionString, {
        openclawVersion,
        variant,
        imageTag,
        imageDigest: imageDigest ?? null,
        publishedAt: parsed.data.publishedAt,
      });
    } catch (e) {
      console.warn('[platform] Failed to write catalog entry to Postgres:', e);
    }
  }

  console.log(
    '[platform] Published image version:',
    openclawVersion,
    variant,
    '→',
    imageTag,
    setLatest ? '(latest)' : '(backfill)'
  );
  return c.json({ ok: true, setLatest, ...parsed.data }, 201);
});

export { platform };
