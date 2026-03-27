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
  GoogleCredentialsSchema,
  SecretsPatchSchema,
} from '../schemas/instance-config';
import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
} from '../schemas/image-version';
import { listAllVersions, resolveLatestVersion, updateTagIndex } from '../lib/image-version';
import { upsertCatalogVersion } from '../lib/catalog-registration';
import { z } from 'zod';
import { withDORetry } from '@kilocode/worker-utils';
import { deriveGatewayToken } from '../auth/gateway-token';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { writeEvent } from '../utils/analytics';
import { deriveHttpEventName } from '../middleware/analytics';

const GmailHistoryIdSchema = z.object({
  userId: z.string().min(1),
  historyId: z.string().min(1),
});

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

// Analytics middleware — runs for every platform route. Captures timing and
// error state. Skips emitting for routes with no user context (e.g. /versions)
// unless an error occurred.
platform.use('*', async (c, next) => {
  const start = c.get('requestStartTime') ?? performance.now();
  let error: string | undefined;
  try {
    await next();
    if (c.res.status >= 400) {
      error = `HTTP ${c.res.status}`;
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    throw err;
  } finally {
    const durationMs = performance.now() - start;
    const method = c.req.method;
    const path = c.req.path;

    // userId is always read from Hono context — set by parseBody() for
    // POST/PATCH routes, or by setValidatedQueryUserId() for GET/DELETE routes.
    const userId = c.get('userId') || '';

    // Skip analytics for routes with no user context (e.g. /versions) unless
    // they errored — no userId means nothing useful to attribute.
    if (userId || error) {
      let sandboxId = '';
      if (userId) {
        try {
          sandboxId = sandboxIdFromUserId(userId);
        } catch {
          // ignore
        }
      }

      writeEvent(c.env, {
        event: deriveHttpEventName(method, path),
        delivery: 'http',
        route: `${method} ${path}`,
        error,
        userId,
        sandboxId,
        durationMs,
      });
    }
  }
});

/**
 * Validate and set userId from the query string onto the Hono context.
 * GET/DELETE routes use this so the analytics middleware can read userId
 * from context without falling back to raw unvalidated query params.
 */
function setValidatedQueryUserId(c: Context<AppEnv>): string | null {
  const parsed = UserIdRequestSchema.safeParse({ userId: c.req.query('userId') });
  if (!parsed.success) {
    return null;
  }

  c.set('userId', parsed.data.userId);
  return parsed.data.userId;
}

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

function jsonError(message: string, status: number, code?: string): Response {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
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
  'Instance is not ', // e.g. "Instance is not running"
  'Instance not ', // e.g. "Instance not provisioned" (DO uses both forms)
  'Instance must be stopped ', // volume reassociation requires stopped state
  'User already has an ', // duplicate provision
  'Gateway controller ', // already sanitized at DO level
  'Config was modified ', // etag mismatch on config replace
  'Invalid secret patch: ', // catalog validation (allFieldsRequired, etc.)
  'Cannot enable Gmail ', // no Google account connected
  'New volume ID is ', // reassociate: same volume
  'Volume ', // reassociate: volume not found / bad state
  'Cannot restore: ', // snapshot restore: bad state
  'Cannot destroy: ', // destroy while restoring
  'Cannot retry recovery', // force-retry-recovery guard messages
];

function sanitizeError(err: unknown, operation: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');

  // Log the full error for Sentry/debugging — this never reaches the caller
  console.error(`[platform] ${operation} failed:`, raw);

  // Allow known-safe messages through
  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { message: normalized, status };
  }

  return { message: `${operation} failed`, status };
}

const OPENCLAW_CONFIG_ERROR_CODES = new Set([
  'controller_route_unavailable',
  'config_etag_conflict',
  'file_etag_conflict',
  'file_not_found',
  'invalid_json_body',
  'invalid_request_body',
]);

function sanitizeOpenclawConfigError(
  err: unknown,
  operation: string
): { message: string; status: number; code?: string } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');
  const code =
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined;

  console.error(`[platform] ${operation} failed:`, raw);

  if (code && OPENCLAW_CONFIG_ERROR_CODES.has(code)) {
    return { message: normalized, status, code };
  }

  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { message: normalized, status, ...(code ? { code } : {}) };
  }

  return { message: `${operation} failed`, status, ...(code ? { code } : {}) };
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

  // Expose userId on the Hono context so the analytics middleware can
  // read it after the handler completes. Platform routes use
  // x-internal-api-key auth (no JWT), so userId comes from the body.
  if (
    parsed.data &&
    typeof parsed.data === 'object' &&
    'userId' in parsed.data &&
    typeof parsed.data.userId === 'string' &&
    parsed.data.userId
  ) {
    c.set('userId', parsed.data.userId);
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
    pinnedImageTag,
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
          pinnedImageTag,
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

// PATCH /api/platform/exec-preset
const ExecPresetPatchSchema = z.object({
  userId: z.string().min(1),
  security: z.string().optional(),
  ask: z.string().optional(),
});

platform.patch('/exec-preset', async c => {
  const result = await parseBody(c, ExecPresetPatchSchema);
  if ('error' in result) return result.error;

  const { userId, security, ask } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateExecPreset({ security, ask }),
      'updateExecPreset'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'exec-preset patch');
    return jsonError(message, status);
  }
});

// POST /api/platform/google-credentials
const GoogleCredentialsPatchSchema = z.object({
  userId: z.string().min(1),
  googleCredentials: GoogleCredentialsSchema,
});

platform.post('/google-credentials', async c => {
  const result = await parseBody(c, GoogleCredentialsPatchSchema);
  if ('error' in result) return result.error;

  const { userId, googleCredentials } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateGoogleCredentials(googleCredentials),
      'updateGoogleCredentials'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-credentials');
    return jsonError(message, status);
  }
});

// DELETE /api/platform/google-credentials?userId=...
platform.delete('/google-credentials', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.clearGoogleCredentials(),
      'clearGoogleCredentials'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'google-credentials delete');
    return jsonError(message, status);
  }
});

// POST /api/platform/gmail-notifications
platform.post('/gmail-notifications', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const { userId } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateGmailNotifications(true),
      'enableGmailNotifications'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-notifications enable');
    return jsonError(message, status);
  }
});

// DELETE /api/platform/gmail-notifications?userId=...
platform.delete('/gmail-notifications', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateGmailNotifications(false),
      'disableGmailNotifications'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-notifications disable');
    return jsonError(message, status);
  }
});

// POST /api/platform/gmail-history-id — best-effort historyId tracking from queue consumer
platform.post('/gmail-history-id', async c => {
  const result = await parseBody(c, GmailHistoryIdSchema);
  if ('error' in result) return result.error;

  const { userId, historyId } = result.data;

  try {
    await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateGmailHistoryId(historyId),
      'updateGmailHistoryId'
    );
    return c.json({ ok: true }, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-history-id update');
    return jsonError(message, status);
  }
});

// GET /api/platform/gmail-oidc-email?userId=...
// Lightweight lookup for the push worker — no Fly live check.
platform.get('/gmail-oidc-email', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getGmailOidcEmail(),
      'getGmailOidcEmail'
    );
    return c.json(result);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'gmail-oidc-email');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/secrets
platform.patch('/secrets', async c => {
  const result = await parseBody(c, SecretsPatchSchema);
  if ('error' in result) return result.error;

  const { userId, secrets, meta } = result.data;

  try {
    const updated = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.updateSecrets(secrets, meta),
      'updateSecrets'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'secrets patch');
    return jsonError(message, status);
  }
});

// GET /api/platform/pairing?userId=...&refresh=true
platform.get('/pairing', async c => {
  const userId = setValidatedQueryUserId(c);
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
  const userId = setValidatedQueryUserId(c);
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
  const userId = setValidatedQueryUserId(c);
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

// GET /api/platform/gateway/ready?userId=...
// Non-fatal polling endpoint — always returns 200 so the frontend poll
// doesn't generate a wall of errors during startup.
platform.get('/gateway/ready', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getGatewayReady(),
      'getGatewayReady'
    );
    return c.json(result ?? { ready: false, error: 'controller too old' }, 200);
  } catch (err) {
    const { message } = sanitizeError(err, 'gateway ready');
    return c.json({ ready: false, error: message }, 200);
  }
});

// GET /api/platform/controller-version?userId=...
platform.get('/controller-version', async c => {
  const userId = setValidatedQueryUserId(c);
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

// GET /api/platform/openclaw-config?userId=...
// Returns the live openclaw.json from the running machine.
platform.get('/openclaw-config', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const config = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getOpenclawConfig(),
      'getOpenclawConfig'
    );
    if (!config) {
      return jsonError('Failed to get OpenClaw config', 404, 'controller_route_unavailable');
    }
    return c.json(config, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config read');
    return jsonError(message, status, code);
  }
});

// POST /api/platform/openclaw-config
// Replace the entire openclaw.json on the running machine.
const ReplaceOpenclawConfigSchema = z.object({
  userId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  etag: z.string().optional(),
});

platform.post('/openclaw-config', async c => {
  const result = await parseBody(c, ReplaceOpenclawConfigSchema);
  if ('error' in result) return result.error;

  const { userId, config, etag } = result.data;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.replaceConfigOnMachine(config, etag),
      'replaceConfigOnMachine'
    );
    if (!response) {
      return jsonError('Failed to update OpenClaw config', 404, 'controller_route_unavailable');
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config replace');
    return jsonError(message, status, code);
  }
});

// PATCH /api/platform/openclaw-config
// Deep-merge a JSON patch into the live openclaw.json on the running machine.
const PatchOpenclawConfigSchema = z.object({
  userId: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
});

platform.patch('/openclaw-config', async c => {
  const result = await parseBody(c, PatchOpenclawConfigSchema);
  if ('error' in result) return result.error;

  const { userId, patch } = result.data;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.patchOpenclawConfig(patch),
      'patchOpenclawConfig'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'openclaw-config patch');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/files/tree?userId=...
platform.get('/files/tree', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getFileTree(),
      'getFileTree'
    );
    if (!result) {
      return jsonError(
        'File browsing not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(result, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/tree');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/files/read?userId=...&path=...
platform.get('/files/read', async c => {
  const userId = setValidatedQueryUserId(c);
  const filePath = c.req.query('path');
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  if (!filePath) {
    return c.json({ error: 'path query parameter is required' }, 400);
  }
  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.readFile(filePath),
      'readFile'
    );
    if (!result) {
      return jsonError(
        'File reading not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(result, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/read');
    return jsonError(message, status, code);
  }
});

const WriteFileSchema = z.object({
  userId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  etag: z.string().optional(),
});

// POST /api/platform/files/write
platform.post('/files/write', async c => {
  const result = await parseBody(c, WriteFileSchema);
  if ('error' in result) return result.error;
  const { userId, path: filePath, content, etag } = result.data;
  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.writeFile(filePath, content, etag),
      'writeFile'
    );
    if (!response) {
      return jsonError(
        'File writing not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'files/write');
    return jsonError(message, status, code);
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
const StartRequestSchema = UserIdRequestSchema.extend({
  skipCooldown: z.boolean().optional(),
});

platform.post('/start', async c => {
  const result = await parseBody(c, StartRequestSchema);
  if ('error' in result) return result.error;
  const startedAt = performance.now();

  try {
    const options = result.data.skipCooldown ? { skipCooldown: true } : undefined;
    const { started } = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.start(result.data.userId, options),
      'start'
    );
    if (started) {
      writeEvent(c.env, {
        event: 'instance.manual_start_succeeded',
        delivery: 'http',
        route: '/api/platform/start',
        userId: result.data.userId,
        durationMs: performance.now() - startedAt,
      });
    }
    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'start');
    writeEvent(c.env, {
      event: 'instance.manual_start_failed',
      delivery: 'http',
      route: '/api/platform/start',
      userId: result.data.userId,
      error: message,
      durationMs: performance.now() - startedAt,
    });
    return jsonError(message, status);
  }
});

// POST /api/platform/force-retry-recovery
platform.post('/force-retry-recovery', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;
  const startedAt = performance.now();

  try {
    const { ok } = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.forceRetryRecovery(),
      'forceRetryRecovery'
    );
    writeEvent(c.env, {
      event: 'instance.force_retry_recovery_succeeded',
      delivery: 'http',
      route: '/api/platform/force-retry-recovery',
      userId: result.data.userId,
      durationMs: performance.now() - startedAt,
    });
    return c.json({ ok });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'forceRetryRecovery');
    writeEvent(c.env, {
      event: 'instance.force_retry_recovery_failed',
      delivery: 'http',
      route: '/api/platform/force-retry-recovery',
      userId: result.data.userId,
      error: message,
      durationMs: performance.now() - startedAt,
    });
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
  const userId = setValidatedQueryUserId(c);
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

// GET /api/platform/stream-chat-credentials?userId=...
platform.get('/stream-chat-credentials', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const creds = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getStreamChatCredentials(),
      'getStreamChatCredentials'
    );
    return c.json(creds);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'stream-chat-credentials');
    return jsonError(message, status);
  }
});

// GET /api/platform/debug-status?userId=...
// Internal/admin-only debug status that includes DO destroy internals.
platform.get('/debug-status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const status = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.getDebugState(),
      'getDebugState'
    );
    return c.json(status);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'debug-status');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway-token?userId=...
// Returns the derived gateway token for a user's sandbox. The Next.js
// dashboard calls this so it never needs GATEWAY_TOKEN_SECRET directly.
platform.get('/gateway-token', async c => {
  const userId = setValidatedQueryUserId(c);
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
  const userId = setValidatedQueryUserId(c);
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

// GET /api/platform/candidate-volumes?userId=...
// Returns all usable volumes in the user's Fly app for admin volume reassociation.
platform.get('/candidate-volumes', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  try {
    const result = await withDORetry(
      instanceStubFactory(c.env, userId),
      stub => stub.listCandidateVolumes(),
      'listCandidateVolumes'
    );
    return c.json(result);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'candidate-volumes');
    return jsonError(message, status);
  }
});

// POST /api/platform/reassociate-volume
// Changes the flyVolumeId on a stopped instance. Requires reason for audit trail.
const ReassociateVolumeSchema = z.object({
  userId: z.string().min(1),
  newVolumeId: z.string().min(1),
  reason: z.string().min(10).max(500),
});

platform.post('/reassociate-volume', async c => {
  const result = await parseBody(c, ReassociateVolumeSchema);
  if ('error' in result) return result.error;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.reassociateVolume(result.data.newVolumeId, result.data.reason),
      'reassociateVolume'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'reassociate-volume');
    return jsonError(message, status);
  }
});

// POST /api/platform/restore-volume-snapshot
// Enqueues a snapshot restore job. Returns immediately; restore runs async via CF Queue.
const RestoreVolumeSnapshotSchema = z.object({
  userId: z.string().min(1),
  snapshotId: z.string().min(1),
});

platform.post('/restore-volume-snapshot', async c => {
  const result = await parseBody(c, RestoreVolumeSnapshotSchema);
  if ('error' in result) return result.error;

  try {
    const response = await withDORetry(
      instanceStubFactory(c.env, result.data.userId),
      stub => stub.enqueueSnapshotRestore(result.data.snapshotId),
      'enqueueSnapshotRestore'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'restore-volume-snapshot');
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

// GET /api/platform/versions/latest
// Returns the current :latest image version from KV.
platform.get('/versions/latest', async c => {
  try {
    const latest = await resolveLatestVersion(c.env.KV_CLAW_CACHE, 'default');
    if (!latest) return c.json({ error: 'No latest version registered' }, 404);
    return c.json(latest);
  } catch (err) {
    console.error('[platform] Failed to get latest version:', err);
    return c.json({ error: 'Failed to get latest version' }, 500);
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

// ---------------------------------------------------------------------------
// Region configuration
// ---------------------------------------------------------------------------

import { FLY_REGIONS_KV_KEY, parseRegions, ALL_VALID_REGIONS } from '../durable-objects/regions';
import { DEFAULT_FLY_REGION } from '../config';

const UpdateRegionsSchema = z.object({
  regions: z
    .array(z.enum(ALL_VALID_REGIONS))
    .min(2, 'At least 2 regions required')
    .refine(
      regions => new Set(regions).size >= 2,
      'Must include at least 2 distinct regions (duplicates bias the shuffle, but need 2+ unique for fallback)'
    ),
});

// GET /api/platform/regions
// Returns the current region configuration with its source.
platform.get('/regions', async c => {
  try {
    const kvValue = await c.env.KV_CLAW_CACHE.get(FLY_REGIONS_KV_KEY);
    const source = kvValue ? 'kv' : c.env.FLY_REGION ? 'env' : 'default';
    const raw = kvValue ?? c.env.FLY_REGION ?? DEFAULT_FLY_REGION;
    const regions = parseRegions(raw);
    return c.json({ regions, source, raw });
  } catch (err) {
    console.error('[platform] Failed to read regions:', err);
    return c.json({ error: 'Failed to read regions' }, 500);
  }
});

// PUT /api/platform/regions
// Updates the region configuration in KV.
platform.put('/regions', async c => {
  const result = await parseBody(c, UpdateRegionsSchema);
  if ('error' in result) return result.error;

  const raw = result.data.regions.join(',');
  try {
    await c.env.KV_CLAW_CACHE.put(FLY_REGIONS_KV_KEY, raw);
  } catch (err) {
    console.error('[platform] Failed to write regions to KV:', err);
    return c.json({ error: 'Failed to write regions' }, 500);
  }

  console.log('[platform] Regions updated:', raw);
  return c.json({ ok: true, regions: result.data.regions, raw });
});

// POST /api/platform/destroy-fly-machine
// This is for admin cleanup only.
// It directly destroys a Fly machine via the Machines API (force=true).
// It does not destroy the Fly app or volume.
const DestroyFlyMachineSchema = z.object({
  userId: z.string().min(1),
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
  machineId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+$/, 'Invalid Fly machine ID'),
});

platform.post('/destroy-fly-machine', async c => {
  const result = await parseBody(c, DestroyFlyMachineSchema);
  if ('error' in result) return result.error;

  const { userId, appName, machineId } = result.data;
  const apiToken = c.env.FLY_API_TOKEN;
  if (!apiToken) {
    return c.json({ error: 'FLY_API_TOKEN is not configured' }, 503);
  }

  const url = `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}?force=true`;
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[platform] destroy-fly-machine failed (${resp.status}) app=${appName} machine=${machineId}:`,
        body
      );
      return jsonError(`Fly API error (${resp.status}): ${body}`, resp.status);
    }

    console.log(`[platform] destroy-fly-machine ok: app=${appName} machine=${machineId}`);

    // Trigger immediate reconcile so the DO discovers the machine is gone.
    try {
      await withDORetry(
        instanceStubFactory(c.env, userId),
        stub => stub.forceRetryRecovery(),
        'forceRetryRecovery'
      );
    } catch (err) {
      console.warn(
        `[platform] destroy-fly-machine: forceRetryRecovery failed for user=${userId}:`,
        err
      );
    }

    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'destroy-fly-machine');
    return jsonError(message, status);
  }
});

export { platform };
