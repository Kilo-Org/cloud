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
  InstanceIdParam,
  MachineSizeSchema,
} from '../schemas/instance-config';
import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
} from '../schemas/image-version';
import { listAllVersions, resolveLatestVersion, updateTagIndex } from '../lib/image-version';
import { upsertCatalogVersion } from '../lib/catalog-registration';
import { flattenError, z } from 'zod';
import { withDORetry } from '@kilocode/worker-utils';
import { readBillingCorrelationHeaders } from '@kilocode/worker-utils/kiloclaw-billing-observability';
import { deriveGatewayToken } from '../auth/gateway-token';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { writeEvent } from '../utils/analytics';
import { deriveHttpEventName } from '../middleware/analytics';
import { sendMessage } from '../stream-chat/client';
import { assertAvailableProvider } from '../providers';
import type { ProviderCapability } from '../providers/types';
import { doKeyFromActiveInstance, resolveDoKeyForUser } from '../lib/instance-routing';
import { getInstanceById, getWorkerDb } from '../db';
import { kiloclaw_inbound_email_aliases } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

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

const WebSearchConfigPatchSchema = z.object({
  userId: z.string().min(1),
  exaMode: z.enum(['kilo-proxy', 'disabled']).nullable().optional(),
});

const KiloCliRunConflictSchema = z.object({
  conflict: z.object({
    code: z.enum([
      'kilo_cli_run_instance_not_running',
      'kilo_cli_run_already_active',
      'kilo_cli_run_no_active_run',
    ]),
    error: z.string().min(1),
  }),
});

const platform = new Hono<AppEnv>();
type KiloClawInstanceStub = ReturnType<AppEnv['Bindings']['KILOCLAW_INSTANCE']['get']>;

type BillingPlatformLogFields = {
  billingFlow?: string;
  billingRunId?: string;
  billingSweep?: string;
  billingCallId?: string;
  billingAttempt?: number;
  billingComponent: 'kiloclaw_platform';
  event: 'downstream_action';
  outcome: 'started' | 'completed' | 'failed';
  method: string;
  path: string;
  durationMs?: number;
  statusCode?: number;
  userId?: string;
  instanceId?: string;
  error?: string;
};

function logBillingPlatform(
  level: 'info' | 'error',
  message: string,
  fields: BillingPlatformLogFields
) {
  const record = JSON.stringify({
    level,
    message,
    ...fields,
  });

  if (level === 'error') {
    console.error(record);
    return;
  }
  console.log(record);
}

// Analytics middleware — runs for every platform route. Captures timing and
// error state. Skips emitting for routes with no user context (e.g. /versions)
// unless an error occurred.
platform.use('*', async (c, next) => {
  const start = c.get('requestStartTime') ?? performance.now();
  const billingContext = readBillingCorrelationHeaders(c.req.raw.headers);
  const method = c.req.method;
  const path = c.req.path;
  const instanceId = c.req.query('instanceId') ?? undefined;

  if (billingContext) {
    logBillingPlatform('info', 'Starting billing-correlated kiloclaw platform request', {
      ...billingContext,
      billingComponent: 'kiloclaw_platform',
      event: 'downstream_action',
      outcome: 'started',
      method,
      path,
      instanceId,
    });
  }

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

    // userId is always read from Hono context — set by parseBody() for
    // POST/PATCH routes, or by setValidatedQueryUserId() for GET/DELETE routes.
    const userId = c.get('userId') || '';

    if (billingContext) {
      const statusCode = c.res.status;
      logBillingPlatform(
        error ? 'error' : 'info',
        'Finished billing-correlated kiloclaw platform request',
        {
          ...billingContext,
          billingComponent: 'kiloclaw_platform',
          event: 'downstream_action',
          outcome: error ? 'failed' : 'completed',
          method,
          path,
          durationMs,
          statusCode,
          userId: userId || undefined,
          instanceId,
          ...(error ? { error } : {}),
        }
      );
    }

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
 * Resolve the DO key for a platform request.
 *
 * When instanceId is provided, it is always authoritative. Otherwise the
 * active Postgres row is the source of truth so legacy sandboxes continue to
 * route to the original userId-keyed DO after kilocode_users.id migrations.
 */
export async function resolveInstanceDoKey(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId?: string
): Promise<string> {
  if (instanceId) return instanceId;

  try {
    return (await resolveDoKeyForUser(env.HYPERDRIVE?.connectionString, userId)) ?? userId;
  } catch (err) {
    console.warn('[platform] Failed to resolve DO key from Postgres, falling back to userId', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return userId;
  }
}

/**
 * Create a fresh KiloClawInstance DO stub.
 * Returns a factory (not the stub itself) so withDORetry can get a fresh stub per attempt.
 */
async function instanceStubFactory(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId?: string
): Promise<() => KiloClawInstanceStub> {
  const doKey = await resolveInstanceDoKey(env, userId, instanceId);
  return () => env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(doKey));
}

async function withResolvedDORetry<TResult>(
  env: AppEnv['Bindings'],
  userId: string,
  instanceId: string | undefined,
  operation: (stub: KiloClawInstanceStub) => Promise<TResult>,
  operationName: string
): Promise<TResult> {
  return withDORetry(await instanceStubFactory(env, userId, instanceId), operation, operationName);
}

/** Parse and validate optional ?instanceId= query param. Returns 400 on invalid format. */
function parseInstanceIdQuery(
  c: Context<AppEnv>
): { instanceId: string | undefined } | { error: Response } {
  const raw = c.req.query('instanceId');
  if (!raw) return { instanceId: undefined };
  const result = InstanceIdParam.safeParse(raw);
  if (!result.success) {
    return {
      error: new Response(JSON.stringify({ error: 'Invalid instance ID' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    };
  }
  return { instanceId: result.data };
}

async function requireProviderCapability(
  c: Context<AppEnv>,
  userId: string,
  instanceId: string | undefined,
  capability: ProviderCapability,
  operation: string,
  options?: { failOpen?: boolean }
): Promise<Response | null> {
  let metadata: {
    provider: string;
    capabilities: Record<ProviderCapability, boolean>;
  };
  try {
    metadata = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getProviderMetadata(),
      'getProviderMetadata'
    );
  } catch (error) {
    if (options?.failOpen) {
      console.warn(`[platform] ${operation}: provider capability lookup failed, proceeding`, error);
      return null;
    }
    throw error;
  }

  if (metadata.capabilities[capability]) {
    return null;
  }

  return jsonError(`${operation} is not supported for provider ${metadata.provider}`, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpStatus(value: unknown): value is { status: number } {
  return isRecord(value) && typeof value.status === 'number';
}

function hasStringCode(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

/** Extract a string `code` from an error or its `.cause`, if present. */
function getErrorCode(err: unknown): string | undefined {
  if (hasStringCode(err)) return err.code;
  if (err instanceof Error && hasStringCode(err.cause)) return err.cause.code;
  return undefined;
}

function statusCodeFromError(err: unknown): number {
  // Extract a valid HTTP status from the error or its cause, defaulting to 500.
  for (const candidate of [err, err instanceof Error ? err.cause : undefined]) {
    if (isHttpStatus(candidate) && candidate.status >= 400 && candidate.status < 600) {
      return candidate.status;
    }
  }
  return 500;
}

function jsonError(message: string, status: number, code?: string): Response {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function kiloCliRunConflictResponse(response: unknown): Response | undefined {
  const result = KiloCliRunConflictSchema.safeParse(response);
  if (result.success) {
    const { code, error } = result.data.conflict;
    return jsonError(error, 409, code);
  }

  if (isRecord(response) && 'conflict' in response) {
    return jsonError('Invalid Kilo CLI conflict response', 502, 'upstream_invalid_response');
  }

  return undefined;
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
  'Cannot resize: ', // resize during destroying/restoring/recovering
  'Cannot retry recovery', // force-retry-recovery guard messages
  'Stream Chat sendMessage failed', // sendMessage HTTP errors
  'Stream Chat is not set up', // no Stream Chat on this instance
  'Provider ', // explicit not-implemented provider errors
];

function sanitizeError(err: unknown, operation: string): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : 'Unknown error';
  const status = statusCodeFromError(err);
  const normalized = raw.replace(/^(?:[A-Za-z]+Error:\s*)+/, '');

  // Log the full error for Sentry/debugging — this never reaches the caller
  console.error(`[platform] ${operation} failed:`, raw);

  // Allow known-safe messages through
  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { message: normalized, status: correctLostStatus(normalized, status) };
  }

  return { message: `${operation} failed`, status };
}

/**
 * DO lifecycle methods throw `Object.assign(new Error('Instance not provisioned'), { status: 404 })`
 * but `.status` is lost crossing the DO RPC boundary, so `statusCodeFromError`
 * defaults to 500. Correct it here for this specific message only.
 *
 * Note: `requireGatewayControllerContext()` in gateway.ts throws the same message
 * with status 409 (conflict). We only correct when status === 500 (i.e. lost),
 * so a preserved 409 passes through unchanged.
 */
function correctLostStatus(message: string, status: number): number {
  if (status === 500 && message === 'Instance not provisioned') return 404;
  if (
    status === 500 &&
    message.startsWith('Provider ') &&
    message.endsWith(' is not implemented yet')
  )
    return 501;
  return status;
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
  const code = getErrorCode(err);

  console.error(`[platform] ${operation} failed:`, raw);

  if (code && OPENCLAW_CONFIG_ERROR_CODES.has(code)) {
    return { message: normalized, status, code };
  }

  if (SAFE_ERROR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return {
      message: normalized,
      status: correctLostStatus(normalized, status),
      ...(code ? { code } : {}),
    };
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
    instanceId,
    orgId,
    provider,
    envVars,
    encryptedSecrets,
    channels,
    kilocodeApiKey,
    kilocodeApiKeyExpiresAt,
    kilocodeDefaultModel,
    userTimezone,
    machineSize,
    region,
    pinnedImageTag,
  } = result.data;

  let provision;
  try {
    if (provider) {
      assertAvailableProvider(c.env, provider);
    }
    provision = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub =>
        stub.provision(
          userId,
          {
            envVars,
            encryptedSecrets,
            channels,
            kilocodeApiKey,
            kilocodeApiKeyExpiresAt,
            kilocodeDefaultModel,
            userTimezone,
            machineSize,
            region,
            pinnedImageTag,
          },
          instanceId || orgId || provider ? { instanceId, orgId, provider } : undefined
        ),
      'provision'
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    if (raw.includes('duplicate key') || raw.includes('unique constraint')) {
      console.error('[platform] provision failed: duplicate instance');
      return c.json({ error: 'User already has an active instance' }, 409);
    }
    const { message, status } = sanitizeError(err, 'provision');
    return jsonError(message, status);
  }

  // Record the instance in the appropriate registry (best-effort).
  // instanceId is always provided by Next.js (the Postgres row UUID).
  if (instanceId) {
    try {
      const registryKey = orgId ? `org:${orgId}` : `user:${userId}`;
      const registryStub = c.env.KILOCLAW_REGISTRY.get(
        c.env.KILOCLAW_REGISTRY.idFromName(registryKey)
      );
      // doKey = instanceId: all new provisions create DOs keyed by instanceId.
      // For lazy-migrated legacy instances, doKey = userId (set in lazyMigrate).
      await registryStub.createInstance(registryKey, userId, instanceId, instanceId);
      console.log('[platform] Registry entry created:', {
        registryKey,
        instanceId,
        doKey: instanceId,
      });
    } catch (registryErr) {
      console.error('[platform] Registry create failed (non-fatal):', registryErr);
    }
  }

  return c.json(provision, 201);
});

// PATCH /api/platform/kilocode-config
platform.patch('/kilocode-config', async c => {
  const result = await parseBody(c, KiloCodeConfigPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, kilocodeApiKey, kilocodeApiKeyExpiresAt, kilocodeDefaultModel } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

// PATCH /api/platform/web-search-config
platform.patch('/web-search-config', async c => {
  const result = await parseBody(c, WebSearchConfigPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, exaMode } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateWebSearchConfig({ exaMode }),
      'updateWebSearchConfig'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'web-search-config patch');
    return jsonError(message, status);
  }
});

// PATCH /api/platform/channels
platform.patch('/channels', async c => {
  const result = await parseBody(c, ChannelsPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, channels } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

const BotIdentityPatchSchema = z.object({
  userId: z.string().min(1),
  botName: z.string().trim().min(1).max(80).nullable().optional(),
  botNature: z.string().trim().min(1).max(120).nullable().optional(),
  botVibe: z.string().trim().min(1).max(120).nullable().optional(),
  botEmoji: z.string().trim().min(1).max(16).nullable().optional(),
});

platform.patch('/exec-preset', async c => {
  const result = await parseBody(c, ExecPresetPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, security, ask } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateExecPreset({ security, ask }),
      'updateExecPreset'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'exec-preset patch');
    return jsonError(message, status);
  }
});

platform.patch('/bot-identity', async c => {
  const result = await parseBody(c, BotIdentityPatchSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, botName, botNature, botVibe, botEmoji } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.updateBotIdentity({ botName, botNature, botVibe, botEmoji }),
      'updateBotIdentity'
    );
    return c.json(updated, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'bot-identity patch');
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, googleCredentials } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, historyId } = result.data;

  try {
    await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, secrets, meta } = result.data;

  try {
    const updated = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, channel, code } = result.data;

  try {
    const approved = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const forceRefresh = c.req.query('refresh') === 'true';

  try {
    const pairing = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, requestId } = result.data;

  try {
    const approved = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const gatewayStatus = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, version } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const config = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, config, etag } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, patch } = result.data;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, path: filePath, content, etag } = result.data;
  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const doctor = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.runDoctor(),
      'runDoctor'
    );
    return c.json(doctor, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'doctor');
    return jsonError(message, status);
  }
});

// ── Kilo CLI Run ──────────────────────────────────────────────────────

const KiloCliRunStartSchema = z.object({
  userId: z.string().min(1),
  prompt: z.string().min(1).max(10_000),
});

// POST /api/platform/kilo-cli-run/start
platform.post('/kilo-cli-run/start', async c => {
  const result = await parseBody(c, KiloCliRunStartSchema);
  if ('error' in result) return result.error;
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    // The DO returns a discriminated union: success | { conflict } | null.
    // CF Workers' RPC type wrapping turns this into `Promise<A> | Promise<B>`
    // instead of `Promise<A | B>`, which breaks narrowing. The `.then(r => r)`
    // collapses the RPC wrapper back to a plain Promise union.
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.startKiloCliRun(result.data.prompt).then(r => r),
      'startKiloCliRun'
    );
    if (!response) {
      return jsonError(
        'Kilo CLI agent not available (controller too old)',
        404,
        'controller_route_unavailable'
      );
    }
    const conflictResponse = kiloCliRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status, code } = sanitizeOpenclawConfigError(err, 'kilo-cli-run start');
    return jsonError(message, status, code);
  }
});

// GET /api/platform/kilo-cli-run/status?userId=...
platform.get('/kilo-cli-run/status', async c => {
  const userId = c.req.query('userId');
  if (!userId) return jsonError('Missing userId', 400);
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
      stub => stub.getKiloCliRunStatus(),
      'getKiloCliRunStatus'
    );
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilo-cli-run status');
    return jsonError(message, status);
  }
});

// POST /api/platform/kilo-cli-run/cancel
platform.post('/kilo-cli-run/cancel', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    // The DO returns a discriminated union: success | { conflict }.
    // See startKiloCliRun for the same pattern and the reason for .then(r => r).
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.cancelKiloCliRun().then(r => r),
      'cancelKiloCliRun'
    );
    const conflictResponse = kiloCliRunConflictResponse(response);
    if (conflictResponse) return conflictResponse;
    return c.json(response, 200);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'kilo-cli-run cancel');
    return jsonError(message, status);
  }
});

// POST /api/platform/start
const StartRequestSchema = UserIdRequestSchema.extend({
  skipCooldown: z.boolean().optional(),
});

async function handleStartRequest(c: Context<AppEnv>, mode: 'sync' | 'async') {
  const result = await parseBody(c, StartRequestSchema);
  if ('error' in result) return result.error;
  const startedAt = performance.now();

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const route = mode === 'async' ? '/api/platform/start-async' : '/api/platform/start';
    const eventBase =
      mode === 'async' ? 'instance.async_start_requested' : 'instance.manual_start_succeeded';
    const options = result.data.skipCooldown ? { skipCooldown: true } : undefined;

    if (mode === 'async') {
      await withResolvedDORetry(
        c.env,
        result.data.userId,
        instanceId,
        stub => stub.startAsync(result.data.userId),
        'startAsync'
      );
    } else {
      const { started } = await withResolvedDORetry(
        c.env,
        result.data.userId,
        instanceId,
        stub => stub.start(result.data.userId, options),
        'start'
      );
      if (!started) {
        return c.json({ ok: true });
      }
    }

    writeEvent(c.env, {
      event: eventBase,
      delivery: 'http',
      route,
      userId: result.data.userId,
      durationMs: performance.now() - startedAt,
    });
    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'start');
    writeEvent(c.env, {
      event:
        mode === 'async' ? 'instance.async_start_request_failed' : 'instance.manual_start_failed',
      delivery: 'http',
      route: mode === 'async' ? '/api/platform/start-async' : '/api/platform/start',
      userId: result.data.userId,
      error: message,
      durationMs: performance.now() - startedAt,
    });
    return jsonError(message, status);
  }
}

platform.post('/start', async c => {
  return handleStartRequest(c, 'sync');
});

platform.post('/start-async', async c => {
  return handleStartRequest(c, 'async');
});

// POST /api/platform/force-retry-recovery
platform.post('/force-retry-recovery', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const startedAt = performance.now();

  try {
    const { ok } = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
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

// POST /api/platform/cleanup-recovery-previous-volume
platform.post('/cleanup-recovery-previous-volume', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.cleanupRecoveryPreviousVolume(),
      'cleanupRecoveryPreviousVolume'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'cleanup-recovery-previous-volume');
    return jsonError(message, status);
  }
});

// POST /api/platform/stop
platform.post('/stop', async c => {
  const result = await parseBody(c, UserIdRequestSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    await withResolvedDORetry(c.env, result.data.userId, instanceId, stub => stub.stop(), 'stop');
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  const { userId } = result.data;
  const doKey = await resolveInstanceDoKey(c.env, userId, instanceId);

  // Read the instance's orgId before destroying so we can update the correct registry.
  let orgId: string | null = null;
  if (instanceId) {
    try {
      const statusStub = (await instanceStubFactory(c.env, userId, instanceId))();
      const status = await statusStub.getStatus();
      orgId = status.orgId;
    } catch {
      // Can't determine orgId. We'll clean up the user registry below; if the
      // instance was org-owned, its org registry entry becomes stale but harmless
      // (points to a destroyed DO that returns no machineId).
      console.warn(
        '[platform] Could not read orgId before destroy, org registry entry may be stale'
      );
    }
  }

  try {
    await withResolvedDORetry(c.env, userId, instanceId, stub => stub.destroy(), 'destroy');

    // Remove the instance from the registry (best-effort).
    // When instanceId is provided, destroy by instanceId directly.
    // When absent (legacy destroy), find the entry with doKey=userId
    // and destroy it by its instanceId from the registry.
    // Note: The Instance DO also cleans up on finalization (belt-and-suspenders).
    try {
      const registryKeys = [`user:${userId}`];
      if (orgId) registryKeys.push(`org:${orgId}`);
      for (const registryKey of registryKeys) {
        const registryStub = c.env.KILOCLAW_REGISTRY.get(
          c.env.KILOCLAW_REGISTRY.idFromName(registryKey)
        );
        if (instanceId) {
          await registryStub.destroyInstance(registryKey, instanceId);
          console.log('[platform] Registry entry destroyed:', { registryKey, instanceId });
        } else {
          // Legacy destroy (no instanceId): find the registry entry by the
          // original legacy DO key recovered from sandboxId/Postgres state.
          const entries = await registryStub.listInstances(registryKey);
          const doKeysToMatch = doKey === userId ? [userId] : [userId, doKey];
          const legacyEntry = entries.find(e => doKeysToMatch.includes(e.doKey));
          if (legacyEntry) {
            await registryStub.destroyInstance(registryKey, legacyEntry.instanceId);
            console.log('[platform] Registry entry destroyed (legacy):', {
              registryKey,
              instanceId: legacyEntry.instanceId,
              doKeysTried: doKeysToMatch,
              matchedDoKey: legacyEntry.doKey,
            });
          } else {
            console.log('[platform] No registry entry found for legacy destroy:', {
              registryKey,
              doKeysTried: doKeysToMatch,
              entriesCount: entries.length,
            });
          }
        }
      }
    } catch (registryErr) {
      console.error('[platform] Registry destroy failed (non-fatal):', registryErr);
    }

    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'destroy');
    return jsonError(message, status);
  }
});

// GET /api/platform/status?userId=...&instanceId=...
platform.get('/status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getStatus(),
      'getStatus'
    );
    return c.json(status);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'status');
    return jsonError(message, status);
  }
});

// GET /api/platform/stream-chat-credentials?userId=...&instanceId=...
platform.get('/stream-chat-credentials', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const creds = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getStreamChatCredentials(),
      'getStreamChatCredentials'
    );
    return c.json(creds);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'stream-chat-credentials');
    return jsonError(message, status);
  }
});

const MAX_INBOUND_EMAIL_TITLE_SLUG_LENGTH = 80;

const InboundEmailSchema = z.object({
  instanceId: z.string().uuid(),
  messageId: z.string().trim().min(1).max(512),
  from: z.string().trim().min(1).max(512),
  to: z.string().trim().min(1).max(512),
  recipientAlias: z.string().trim().min(1).max(512).optional(),
  subject: z.string().max(1_000),
  text: z.string().min(1).max(32_000),
  receivedAt: z.string().datetime(),
});

type InboundEmailDelivery = z.infer<typeof InboundEmailSchema>;

function inboundEmailTitleSlug(subject: string): string {
  const slug = subject
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_INBOUND_EMAIL_TITLE_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return slug || 'no-subject';
}

function inboundEmailSessionKey(subject: string, receivedAt: string): string {
  return `inbound-email:${receivedAt.slice(0, 10)}-${inboundEmailTitleSlug(subject)}`;
}

function inboundEmailAddressParts(address: string): {
  localPart: string;
  domain: string;
  validSingleAddress: boolean;
} {
  const [localPart, domain, ...extra] = address.trim().toLowerCase().split('@');
  return {
    localPart: localPart ?? '',
    domain: domain ?? '',
    validSingleAddress: Boolean(localPart && domain && extra.length === 0),
  };
}

function inboundEmailLogContext(delivery: InboundEmailDelivery) {
  const recipient = inboundEmailAddressParts(delivery.to);
  const sender = inboundEmailAddressParts(delivery.from);

  return {
    instanceId: delivery.instanceId,
    messageIdLength: delivery.messageId.length,
    fromDomain: sender.domain,
    toLocalPart: recipient.localPart,
    toDomain: recipient.domain,
    toAddressValid: recipient.validSingleAddress,
    recipientAlias: delivery.recipientAlias ?? null,
    subjectLength: delivery.subject.length,
    textLength: delivery.text.length,
    receivedAt: delivery.receivedAt,
  };
}

async function resolveInboundEmailDoKey(
  env: AppEnv['Bindings'],
  instance: { id: string; userId: string; sandboxId: string; orgId: string | null }
): Promise<string> {
  const ownerKey = instance.orgId ? `org:${instance.orgId}` : `user:${instance.userId}`;
  try {
    const registryStub = env.KILOCLAW_REGISTRY.get(env.KILOCLAW_REGISTRY.idFromName(ownerKey));
    const doKey = await registryStub.resolveDoKey(ownerKey, instance.id);
    if (doKey) return doKey;
  } catch (err) {
    console.warn(
      '[platform] inbound-email registry lookup failed, falling back to instance identity',
      {
        instanceId: instance.id,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
  return doKeyFromActiveInstance(instance);
}

// POST /api/platform/inbound-email
// Deliver a Cloudflare Email Routing message to an instance's OpenClaw hook endpoint.
platform.post('/inbound-email', async c => {
  const startedAt = performance.now();
  const result = await parseBody(c, InboundEmailSchema);
  if ('error' in result) return result.error;

  const delivery = result.data;
  const logContext = inboundEmailLogContext(delivery);
  const recipientAlias = delivery.recipientAlias?.toLowerCase();
  console.log('[platform] inbound email received', logContext);
  if (!recipientAlias) {
    console.warn('[platform] inbound email missing alias metadata', logContext);
    return jsonError('Inbound email address is no longer available', 410);
  }

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.error('[platform] inbound email database unavailable', logContext);
    return jsonError('Database is not configured', 503);
  }
  if (!c.env.GATEWAY_TOKEN_SECRET) {
    console.error('[platform] inbound email gateway token secret unavailable', logContext);
    return jsonError('GATEWAY_TOKEN_SECRET is not configured', 503);
  }

  try {
    const db = getWorkerDb(connectionString);
    const instance = await getInstanceById(db, delivery.instanceId);
    if (!instance) {
      console.warn('[platform] inbound email instance not found', logContext);
      return jsonError('Instance not found', 404);
    }
    if (!instance.inboundEmailEnabled) {
      console.warn('[platform] inbound email disabled for instance', logContext);
      return jsonError('Inbound email is disabled for this instance', 410);
    }

    const [activeAlias] = await db
      .select({ alias: kiloclaw_inbound_email_aliases.alias })
      .from(kiloclaw_inbound_email_aliases)
      .where(
        and(
          eq(kiloclaw_inbound_email_aliases.instance_id, instance.id),
          eq(kiloclaw_inbound_email_aliases.alias, recipientAlias),
          isNull(kiloclaw_inbound_email_aliases.retired_at)
        )
      )
      .limit(1);
    if (!activeAlias) {
      console.warn('[platform] inbound email alias is not active', logContext);
      return jsonError('Inbound email address is no longer available', 410);
    }

    c.set('userId', instance.userId);
    console.log('[platform] inbound email instance resolved', {
      ...logContext,
      userId: instance.userId,
      sandboxId: instance.sandboxId,
      orgId: instance.orgId,
    });

    const doKey = await resolveInboundEmailDoKey(c.env, instance);
    console.log('[platform] inbound email DO resolved', {
      ...logContext,
      userId: instance.userId,
      orgId: instance.orgId,
      doKey,
      doKeyMatchesInstanceId: doKey === instance.id,
    });

    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));
    const status = await stub.getStatus();
    console.log('[platform] inbound email status resolved', {
      ...logContext,
      userId: instance.userId,
      doKey,
      instanceStatus: status.status,
      statusUserId: status.userId,
      statusSandboxId: status.sandboxId,
      hasSandboxId: Boolean(status.sandboxId),
    });

    if (status.status !== 'running') {
      console.warn('[platform] inbound email instance is not running', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance is not running', 503);
    }
    if (!status.sandboxId) {
      console.error('[platform] inbound email instance has no sandboxId', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance has no sandboxId', 500);
    }

    const routingTarget = await stub.getRoutingTarget();
    if (!routingTarget) {
      console.warn('[platform] inbound email instance not routable', {
        ...logContext,
        userId: instance.userId,
        doKey,
        instanceStatus: status.status,
      });
      return jsonError('Instance not routable', 503);
    }
    console.log('[platform] inbound email routing target resolved', {
      ...logContext,
      userId: instance.userId,
      doKey,
      targetOrigin: routingTarget.origin,
      hasFlyForceInstanceId: 'fly-force-instance-id' in routingTarget.headers,
    });

    const gatewayToken = await deriveGatewayToken(status.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
    const sessionKey = inboundEmailSessionKey(delivery.subject, delivery.receivedAt);
    console.log('[platform] inbound email forwarding to controller', {
      ...logContext,
      userId: instance.userId,
      doKey,
      targetOrigin: routingTarget.origin,
      sessionKeyPrefix: sessionKey.split(':')[0] ?? '',
      sessionKeyLength: sessionKey.length,
    });
    const response = await fetch(`${routingTarget.origin}/_kilo/hooks/email`, {
      method: 'POST',
      headers: {
        ...routingTarget.headers,
        authorization: `Bearer ${gatewayToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionKey,
        messageId: delivery.messageId,
        from: delivery.from,
        to: delivery.to,
        subject: delivery.subject,
        text: delivery.text,
        receivedAt: delivery.receivedAt,
      }),
    });

    console.log('[platform] inbound email controller response', {
      ...logContext,
      userId: instance.userId,
      doKey,
      status: response.status,
      ok: response.ok,
      durationMs: performance.now() - startedAt,
    });

    if (response.ok) {
      writeEvent(c.env, {
        event: 'instance.webhook_chat_message_sent',
        delivery: 'http',
        route: '/api/platform/inbound-email',
        userId: instance.userId,
        instanceId: instance.id,
      });
      return c.json({ success: true }, 202);
    }

    const error = await response.text().catch(() => '');
    const controllerFailure = {
      ...logContext,
      userId: instance.userId,
      doKey,
      status: response.status,
      error: error.slice(0, 500),
      durationMs: performance.now() - startedAt,
    };
    if (response.status >= 500) {
      console.error('[platform] inbound email controller delivery failed', controllerFailure);
    } else {
      console.warn('[platform] inbound email controller rejected delivery', controllerFailure);
    }

    const responseStatus = response.status >= 400 && response.status < 600 ? response.status : 502;
    return jsonError('Inbound email delivery failed', responseStatus);
  } catch (err) {
    console.error('[platform] inbound email delivery threw', {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - startedAt,
    });
    const { message, status } = sanitizeError(err, 'inbound-email');
    return jsonError(message, status);
  }
});

// POST /api/platform/send-chat-message
// Send a message to a KiloClaw instance's Stream Chat channel as the human user.
// The OpenClaw bot picks it up and responds as if the user typed it.
const SendChatMessageSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
  message: z.string().min(1).max(32_000),
});

platform.post('/send-chat-message', async c => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = SendChatMessageSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError('Invalid request body: userId and message are required', 400);
  }

  const { userId, instanceId, message } = parsed.data;
  c.set('userId', userId);

  const apiKey = c.env.STREAM_CHAT_API_KEY;
  const apiSecret = c.env.STREAM_CHAT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return jsonError('Stream Chat is not configured', 503);
  }

  try {
    // Use instanceId as the DO key when available (matches how other endpoints resolve DOs).
    // Falls back to userId for backward compatibility with triggers that predate instanceId.
    const creds = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getStreamChatCredentials(),
      'getStreamChatCredentials'
    );

    if (!creds) {
      return jsonError('Stream Chat is not set up for this instance', 404);
    }

    await sendMessage(apiKey, apiSecret, creds.channelId, creds.userId, message);

    writeEvent(c.env, {
      event: 'instance.webhook_chat_message_sent',
      delivery: 'http',
      route: '/api/platform/send-chat-message',
      userId,
      instanceId: instanceId ?? undefined,
      channelId: creds.channelId,
    });

    return c.json({ success: true, channelId: creds.channelId });
  } catch (err) {
    const { message: errMsg, status } = sanitizeError(err, 'send-chat-message');

    writeEvent(c.env, {
      event: 'instance.webhook_chat_message_failed',
      delivery: 'http',
      route: '/api/platform/send-chat-message',
      userId,
      instanceId: instanceId ?? undefined,
      error: errMsg,
    });

    return jsonError(errMsg, status);
  }
});

// GET /api/platform/debug-status?userId=...&instanceId=...
// Internal/admin-only debug status that includes DO destroy internals.
platform.get('/debug-status', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
      stub => stub.getDebugState(),
      'getDebugState'
    );
    return c.json(status);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'debug-status');
    return jsonError(message, status);
  }
});

// GET /api/platform/registry-entries?userId=...&orgId=...
// Returns all registry entries (including destroyed) for admin inspection.
// Queries the personal registry and optionally the org registry.
platform.get('/registry-entries', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) return c.json({ error: 'userId query parameter is required' }, 400);
  const orgId = c.req.query('orgId') ?? null;

  const results: Array<{
    registryKey: string;
    entries: Array<{
      instanceId: string;
      doKey: string;
      assignedUserId: string;
      createdAt: string;
      destroyedAt: string | null;
    }>;
    migrated: boolean;
  }> = [];

  try {
    // Always query the personal registry
    const userKey = `user:${userId}`;
    const userStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(userKey));
    const userResult = await userStub.listAllInstances(userKey);
    results.push({ registryKey: userKey, ...userResult });

    // If orgId is provided, also query the org registry
    if (orgId) {
      const orgKey = `org:${orgId}`;
      const orgStub = c.env.KILOCLAW_REGISTRY.get(c.env.KILOCLAW_REGISTRY.idFromName(orgKey));
      const orgResult = await orgStub.listAllInstances(orgKey);
      results.push({ registryKey: orgKey, ...orgResult });
    }

    return c.json({ registries: results });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'registry-entries');
    return jsonError(message, status);
  }
});

// GET /api/platform/gateway-token?userId=...&instanceId=...
// Returns the derived gateway token for a user's sandbox. The Next.js
// dashboard calls this so it never needs GATEWAY_TOKEN_SECRET directly.
platform.get('/gateway-token', async c => {
  const userId = setValidatedQueryUserId(c);
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }
  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;
  const { instanceId } = iidResult;

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json({ error: 'GATEWAY_TOKEN_SECRET is not configured' }, 503);
  }

  try {
    const status = await withResolvedDORetry(
      c.env,
      userId,
      instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'volumeSnapshots',
    'volume-snapshots',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const snapshots = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'candidateVolumes',
    'candidate-volumes',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const result = await withResolvedDORetry(
      c.env,
      userId,
      iidResult.instanceId,
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    result.data.userId,
    iidResult.instanceId,
    'volumeReassociation',
    'reassociate-volume',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.reassociateVolume(result.data.newVolumeId, result.data.reason),
      'reassociateVolume'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'reassociate-volume');
    return jsonError(message, status);
  }
});

// POST /api/platform/resize-machine
// Updates the machine size for an instance. Takes effect on next start/restart.
const ResizeMachineSchema = z.object({
  userId: z.string().min(1),
  machineSize: MachineSizeSchema,
});

platform.post('/resize-machine', async c => {
  const result = await parseBody(c, ResizeMachineSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
      stub => stub.resizeMachine(result.data.machineSize),
      'resizeMachine'
    );
    return c.json(response);
  } catch (err) {
    const { message, status } = sanitizeError(err, 'resize-machine');
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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const unsupported = await requireProviderCapability(
    c,
    result.data.userId,
    iidResult.instanceId,
    'snapshotRestore',
    'restore-volume-snapshot',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  try {
    const response = await withResolvedDORetry(
      c.env,
      result.data.userId,
      iidResult.instanceId,
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
import { FLY_API_BASE } from '../fly/client';

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

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { userId, appName, machineId } = result.data;
  const unsupported = await requireProviderCapability(
    c,
    userId,
    iidResult.instanceId,
    'directMachineDestroy',
    'destroy-fly-machine',
    { failOpen: true }
  );
  if (unsupported) return unsupported;

  const apiToken = c.env.FLY_API_TOKEN;
  if (!apiToken) {
    return c.json({ error: 'FLY_API_TOKEN is not configured' }, 503);
  }

  const url = `${FLY_API_BASE}/v1/apps/${appName}/machines/${machineId}?force=true`;
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
      await withResolvedDORetry(
        c.env,
        userId,
        iidResult.instanceId,
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

// POST /api/platform/extend-volume
// Temporary workaround: extend a Fly volume to exactly 15 GB.
const EXTEND_VOLUME_TARGET_SIZE_GB = 15;
const ExtendVolumeSchema = z.object({
  userId: z.string().min(1),
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
  volumeId: z
    .string()
    .min(1)
    .regex(/^vol_[a-zA-Z0-9]+$/, 'Invalid Fly volume ID'),
});

const FlyExtendVolumeResponseSchema = z.object({
  needs_restart: z.boolean().optional(),
});

platform.post('/extend-volume', async c => {
  const result = await parseBody(c, ExtendVolumeSchema);
  if ('error' in result) return result.error;

  const iidResult = parseInstanceIdQuery(c);
  if ('error' in iidResult) return iidResult.error;

  const { appName, volumeId } = result.data;
  const apiToken = c.env.FLY_API_TOKEN;
  if (!apiToken) {
    return c.json({ error: 'FLY_API_TOKEN is not configured' }, 503);
  }

  const url = `${FLY_API_BASE}/v1/apps/${appName}/volumes/${volumeId}/extend`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size_gb: EXTEND_VOLUME_TARGET_SIZE_GB }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[platform] extend-volume failed (${resp.status}) volume=${volumeId} size=${EXTEND_VOLUME_TARGET_SIZE_GB}:`,
        body
      );
      return jsonError(`Fly API error (${resp.status}): ${body}`, resp.status);
    }

    const extendParsed = FlyExtendVolumeResponseSchema.safeParse(await resp.json());
    if (!extendParsed.success) {
      console.error(
        `[platform] extend-volume unexpected response shape volume=${volumeId}:`,
        flattenError(extendParsed.error)
      );
      return jsonError('Unexpected Fly extend-volume response', 502);
    }
    // Default to true so the admin always sees the redeploy warning when Fly omits the flag
    const needsRestart = extendParsed.data.needs_restart ?? true;
    console.log(
      `[platform] extend-volume ok: volume=${volumeId} size=${EXTEND_VOLUME_TARGET_SIZE_GB}GB (target total) needsRestart=${needsRestart}`
    );
    return c.json({ ok: true as const, needsRestart });
  } catch (err) {
    const { message, status } = sanitizeError(err, 'extend-volume');
    return jsonError(message, status);
  }
});

export { platform };
