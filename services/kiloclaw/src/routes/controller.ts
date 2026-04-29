import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  decryptWithSymmetricKey,
  encryptWithSymmetricKey,
  timingSafeEqual,
} from '@kilocode/encryption';
import type { AppEnv } from '../types';
import { userIdFromSandboxId } from '../auth/sandbox-id';
import {
  isInstanceKeyedSandboxId,
  instanceIdFromSandboxId,
} from '@kilocode/worker-utils/instance-id';
import { deriveGatewayToken } from '../auth/gateway-token';
import { waitUntil } from 'cloudflare:workers';
import {
  findEmailByUserId,
  getGoogleOAuthConnectionByInstanceId,
  getInstanceBySandboxId,
  getWorkerDb,
  updateGoogleOAuthConnectionTokenData,
} from '../db';
import { capturePostHogEvent } from '../lib/posthog';

const ProductTelemetrySchema = z.object({
  openclawVersion: z.string().nullable(),
  defaultModel: z.string().nullable(),
  channelCount: z.number().int().min(0),
  enabledChannels: z.array(z.string()),
  toolsProfile: z.string().nullable(),
  execSecurity: z.string().nullable(),
  botName: z.string().nullable().optional(),
  botNature: z.string().nullable().optional(),
  botVibe: z.string().nullable().optional(),
  botEmoji: z.string().nullable().optional(),
  browserEnabled: z.boolean(),
  googleLegacyMigrationAttempted: z.boolean().optional(),
  googleLegacyMigrationSucceeded: z.boolean().optional(),
  googleLegacyMigrationFailureReason: z.string().nullable().optional(),
});

const INSTANCE_READY_LOAD_THRESHOLD = 0.1;

const DiskBytesSchema = z
  .number()
  .int()
  .nullable()
  .optional()
  .transform(value => Math.max(value ?? 0, 0));

const CheckinSchema = z.object({
  sandboxId: z.string().min(1),
  machineId: z.string().optional(),
  controllerVersion: z.string().min(1),
  controllerCommit: z.string().min(1),
  openclawVersion: z.string().nullable(),
  openclawCommit: z.string().nullable(),
  supervisorState: z.string().min(1),
  totalRestarts: z.number().min(0),
  restartsSinceLastCheckin: z.number().min(0),
  uptimeSeconds: z.number().min(0),
  loadAvg5m: z.number().min(0),
  bandwidthBytesIn: z.number().min(0),
  bandwidthBytesOut: z.number().min(0),
  lastExitReason: z.string().optional(),
  diskUsedBytes: DiskBytesSchema,
  diskTotalBytes: DiskBytesSchema,
  productTelemetry: ProductTelemetrySchema.optional(),
});

const GoogleTokenRequestSchema = z.object({
  sandboxId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1).default(['calendar_read']),
});

const GoogleStatusRequestSchema = z.object({
  sandboxId: z.string().min(1),
});

type GoogleOAuthConnectionStatus = 'active' | 'action_required' | 'disconnected';

const GoogleMigrateLegacyRequestSchema = z.object({
  sandboxId: z.string().min(1),
  accountEmail: z.string().email(),
  accountSubject: z.string().min(1),
  refreshToken: z.string().min(1),
  oauthClientId: z.string().min(1),
  oauthClientSecret: z.string().min(1),
  scopes: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
});

const GOOGLE_CAPABILITY_SCOPES: Record<string, readonly string[]> = {
  calendar_read: ['https://www.googleapis.com/auth/calendar.readonly'],
  gmail_read: ['https://www.googleapis.com/auth/gmail.readonly'],
  drive_read: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
};

type GoogleGrantsBySource = {
  legacy?: string[];
  oauth?: string[];
};

function sqlTextArray(values: readonly string[]) {
  if (values.length === 0) {
    return sql`ARRAY[]::text[]`;
  }

  return sql`ARRAY[${sql.join(
    values.map(value => sql`${value}`),
    sql`, `
  )}]::text[]`;
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map(capability => capability.trim()).filter(Boolean))].sort();
}

function parseGoogleGrantsBySource(raw: unknown): GoogleGrantsBySource {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const parseList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  const legacy = normalizeCapabilities(parseList(obj.legacy));
  const oauth = normalizeCapabilities(parseList(obj.oauth));
  const grants: GoogleGrantsBySource = {};
  if (legacy.length > 0) grants.legacy = legacy;
  if (oauth.length > 0) grants.oauth = oauth;
  return grants;
}

function effectiveGoogleCapabilities(grants: GoogleGrantsBySource): string[] {
  return normalizeCapabilities([...(grants.legacy ?? []), ...(grants.oauth ?? [])]);
}

/**
 * Return the backend app origin for internal API calls.
 * Uses the dedicated BACKEND_API_URL env var set in wrangler.jsonc.
 */
function backendApiOrigin(backendApiUrl: string | undefined): string {
  if (!backendApiUrl) {
    throw new Error('BACKEND_API_URL is not configured');
  }
  return new URL(backendApiUrl).origin;
}

/**
 * Fire-and-forget HTTP POST to the backend internal API to trigger
 * the "instance ready" transactional email.
 */
async function notifyInstanceReady(
  backendOrigin: string,
  internalSecret: string,
  userId: string,
  sandboxId: string,
  instanceId?: string,
  shouldNotify?: boolean
): Promise<void> {
  const res = await fetch(`${backendOrigin}/api/internal/kiloclaw/instance-ready`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': internalSecret,
    },
    body: JSON.stringify({ userId, sandboxId, instanceId, shouldNotify }),
  });
  if (!res.ok) {
    console.error('[controller] instance-ready notification failed:', res.status, await res.text());
  }
}

const controller = new Hono<AppEnv>();

function parseScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

function hasRequiredCapabilities(
  requestedCapabilities: readonly string[],
  grantedCapabilities: readonly string[]
): boolean {
  const granted = new Set(grantedCapabilities);
  return requestedCapabilities.every(capability => granted.has(capability));
}

function mapGoogleRefreshError(error: unknown): {
  code: string;
  description: string;
} {
  if (!error || typeof error !== 'object') {
    return { code: 'unknown_error', description: 'Google refresh failed' };
  }

  const obj = error as Record<string, unknown>;
  const code = typeof obj.error === 'string' ? obj.error : 'unknown_error';
  const description =
    typeof obj.error_description === 'string' ? obj.error_description : 'Google refresh failed';

  return { code, description };
}

async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{
  accessToken: string;
  expiresAt: string;
  scopes: string[];
  refreshToken?: string;
}> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw payload;
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : typeof payload.expires_in === 'string'
        ? Number.parseInt(payload.expires_in, 10)
        : null;

  if (!accessToken || !expiresIn || Number.isNaN(expiresIn) || expiresIn <= 0) {
    throw {
      error: 'invalid_token_response',
      error_description: 'Google token endpoint returned an invalid payload',
    };
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const scopes = parseScopes(typeof payload.scope === 'string' ? payload.scope : undefined);

  return {
    accessToken,
    expiresAt,
    scopes,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
  };
}

async function authorizeGoogleControllerRequest(c: Context<AppEnv>, sandboxId: string) {
  const authHeader = c.req.header('authorization');
  const apiKey = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.substring(7)
    : undefined;

  const gatewayToken = c.req.header('x-kiloclaw-gateway-token');
  if (!apiKey || !gatewayToken) {
    return { error: c.json({ error: 'Unauthorized' }, 401) };
  }

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return { error: c.json({ error: 'Configuration error' }, 503) };
  }

  const expectedGatewayToken = await deriveGatewayToken(sandboxId, c.env.GATEWAY_TOKEN_SECRET);
  if (!timingSafeEqual(gatewayToken, expectedGatewayToken)) {
    return { error: c.json({ error: 'Forbidden' }, 403) };
  }

  let doKey: string;
  if (isInstanceKeyedSandboxId(sandboxId)) {
    doKey = instanceIdFromSandboxId(sandboxId);
  } else {
    try {
      doKey = userIdFromSandboxId(sandboxId);
    } catch {
      return { error: c.json({ error: 'Invalid sandboxId' }, 400) };
    }
  }

  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));
  const config = await stub.getConfig().catch(() => null);
  if (!config?.kilocodeApiKey || !timingSafeEqual(apiKey, config.kilocodeApiKey)) {
    return { error: c.json({ error: 'Forbidden' }, 403) };
  }

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return { error: c.json({ error: 'Database unavailable' }, 503) };
  }

  const db = getWorkerDb(connectionString);
  const instance = await getInstanceBySandboxId(db, sandboxId);
  if (!instance) {
    return { error: c.json({ error: 'Instance not found' }, 404) };
  }

  return { apiKey, gatewayToken, db, instance, stub };
}

controller.post('/checkin', async (c: Context<AppEnv>) => {
  const authHeader = c.req.header('authorization');
  const apiKey = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.substring(7)
    : undefined;

  const gatewayToken = c.req.header('x-kiloclaw-gateway-token');
  if (!apiKey || !gatewayToken) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const rawBody: unknown = await c.req.json().catch((): unknown => null);
  const parsed = CheckinSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body' }, 400);
  }

  const data = parsed.data;

  if (!c.env.GATEWAY_TOKEN_SECRET) {
    return c.json({ error: 'Configuration error' }, 503);
  }

  const expectedGatewayToken = await deriveGatewayToken(data.sandboxId, c.env.GATEWAY_TOKEN_SECRET);
  if (!timingSafeEqual(gatewayToken, expectedGatewayToken)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // For instance-keyed sandboxIds (ki_ prefix), the DO key is the instanceId.
  // For legacy sandboxIds (base64url), the DO key is the userId.
  let doKey: string;
  if (isInstanceKeyedSandboxId(data.sandboxId)) {
    doKey = instanceIdFromSandboxId(data.sandboxId);
  } else {
    try {
      doKey = userIdFromSandboxId(data.sandboxId);
    } catch {
      return c.json({ error: 'Invalid sandboxId' }, 400);
    }
  }

  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));
  const config = await stub.getConfig().catch(() => null);
  if (!config?.kilocodeApiKey || !timingSafeEqual(apiKey, config.kilocodeApiKey)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Resolve the real userId from the DO — needed for PostHog attribution and
  // instance-ready emails. For legacy DOs, doKey IS the userId. For instance-keyed
  // DOs, doKey is the instanceId and the DO stores the actual userId.
  const status = await stub.getStatus();
  const userId = status.userId ?? doKey;

  try {
    const flyRegion = c.req.header('fly-region') ?? '';
    c.env.KILOCLAW_CONTROLLER_AE.writeDataPoint({
      blobs: [
        data.sandboxId,
        data.controllerVersion,
        data.controllerCommit,
        data.openclawVersion ?? '',
        data.openclawCommit ?? '',
        data.supervisorState,
        flyRegion,
        data.machineId ?? '',
        data.lastExitReason ?? '',
      ],
      doubles: [
        data.restartsSinceLastCheckin,
        data.totalRestarts,
        data.uptimeSeconds,
        data.loadAvg5m,
        data.bandwidthBytesIn,
        data.bandwidthBytesOut,
        data.diskUsedBytes,
        data.diskTotalBytes,
      ],
      indexes: [data.sandboxId],
    });
  } catch {
    // Best-effort: never fail checkin on AE write errors
  }

  // Forward product telemetry to PostHog (~every 24h). Skip in development.
  // Runs in background via waitUntil so it never delays the checkin response.
  if (data.productTelemetry && c.env.NEXT_PUBLIC_POSTHOG_KEY && c.env.WORKER_ENV === 'production') {
    const posthogKey = c.env.NEXT_PUBLIC_POSTHOG_KEY;
    const connectionString = c.env.HYPERDRIVE?.connectionString;
    const telemetryPayload = data.productTelemetry;
    const telemetryMeta = {
      sandboxId: data.sandboxId,
      machineId: data.machineId ?? '',
      flyRegion: c.req.header('fly-region') ?? '',
      userId,
    };

    const telemetryPromise = (async () => {
      try {
        let distinctId = userId;
        if (connectionString) {
          const email = await findEmailByUserId(getWorkerDb(connectionString), userId);
          if (email) distinctId = email;
        }

        await capturePostHogEvent({
          apiKey: posthogKey,
          distinctId,
          event: 'kc_instance_product_telemetry',
          properties: { ...telemetryPayload, ...telemetryMeta },
        });
      } catch (err) {
        console.warn('[controller] PostHog capture failed (non-fatal):', err);
      }
    })();

    waitUntil(telemetryPromise);
  }

  // Instance readiness detection: when load drops below threshold, notify the
  // backend so it can send the one-time "instance ready" email and finalize
  // any pending async auto-resume state for this instance.
  if (data.loadAvg5m <= INSTANCE_READY_LOAD_THRESHOLD) {
    try {
      const apiOrigin = backendApiOrigin(c.env.BACKEND_API_URL);
      const { shouldNotify } = await stub.tryMarkInstanceReady();

      if (c.env.INTERNAL_API_SECRET) {
        console.log('[controller] instance-ready: dispatching notification', {
          userId,
          sandboxId: data.sandboxId,
          instanceId: isInstanceKeyedSandboxId(data.sandboxId) ? doKey : null,
          shouldNotify,
        });
        waitUntil(
          notifyInstanceReady(
            apiOrigin,
            c.env.INTERNAL_API_SECRET,
            userId,
            data.sandboxId,
            isInstanceKeyedSandboxId(data.sandboxId) ? doKey : undefined,
            shouldNotify
          ).catch(err => {
            console.error('[controller] instance-ready notification error:', err);
          })
        );
      }
    } catch (err) {
      // Best-effort: never fail checkin on readiness notification errors
      console.error('[controller] instance-ready: tryMarkInstanceReady failed:', err);
    }
  }

  return c.body(null, 204);
});

controller.post('/google/token', async (c: Context<AppEnv>) => {
  const rawBody: unknown = await c.req.json().catch((): unknown => null);
  const parsed = GoogleTokenRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { sandboxId, capabilities } = parsed.data;
  const authorized = await authorizeGoogleControllerRequest(c, sandboxId);
  if ('error' in authorized) {
    return authorized.error;
  }

  const { db, instance, stub } = authorized;

  const connection = await getGoogleOAuthConnectionByInstanceId(db, instance.id);
  if (!connection || connection.provider !== 'google') {
    return c.json({ error: 'Google OAuth is not connected for this instance' }, 404);
  }

  if (connection.status !== 'active') {
    return c.json({ error: 'Google OAuth requires reconnect', status: connection.status }, 409);
  }

  const unsupportedCapabilities = capabilities.filter(
    capability => !(capability in GOOGLE_CAPABILITY_SCOPES)
  );
  if (unsupportedCapabilities.length > 0) {
    return c.json(
      { error: `Unsupported capabilities: ${unsupportedCapabilities.join(', ')}` },
      400
    );
  }

  if (!hasRequiredCapabilities(capabilities, connection.capabilities)) {
    return c.json({ error: 'Requested capabilities are not granted for this instance' }, 412);
  }

  const encryptionKey = c.env.GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return c.json({ error: 'Google OAuth broker is not configured' }, 503);
  }

  const profile = connection.credential_profile === 'legacy' ? 'legacy' : 'kilo_owned';
  const clientId =
    profile === 'legacy' ? connection.oauth_client_id : c.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID;
  let clientSecret =
    profile === 'legacy'
      ? (connection.oauth_client_secret_encrypted ?? '')
      : (c.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET ?? '');

  if (!clientId || !clientSecret) {
    return c.json({ error: `Google OAuth broker profile ${profile} is not configured` }, 503);
  }

  let refreshToken: string;
  try {
    refreshToken = decryptWithSymmetricKey(connection.refresh_token_encrypted, encryptionKey);
    if (profile === 'legacy') {
      clientSecret = decryptWithSymmetricKey(clientSecret, encryptionKey);
    }
  } catch (error) {
    console.error('[controller] Failed to decrypt Google refresh token:', error);
    await updateGoogleOAuthConnectionTokenData(db, instance.id, {
      status: 'action_required',
      lastError: 'refresh_token_decryption_failed',
      lastErrorAt: new Date().toISOString(),
    });
    await stub.updateGoogleOAuthConnection({
      status: 'action_required',
      accountEmail: connection.account_email,
      accountSubject: connection.account_subject,
      scopes: connection.scopes,
      capabilities: connection.capabilities,
      lastError: 'refresh_token_decryption_failed',
    });
    return c.json({ error: 'Google OAuth token is invalid and requires reconnect' }, 409);
  }

  try {
    const refreshed = await refreshGoogleAccessToken({
      clientId,
      clientSecret,
      refreshToken,
    });

    const nextScopes = refreshed.scopes.length > 0 ? refreshed.scopes : connection.scopes;
    await updateGoogleOAuthConnectionTokenData(db, instance.id, {
      refreshTokenEncrypted: refreshed.refreshToken
        ? encryptWithSymmetricKey(refreshed.refreshToken, encryptionKey)
        : undefined,
      scopes: nextScopes,
      status: 'active',
      lastError: null,
      lastErrorAt: null,
    });

    await stub.updateGoogleOAuthConnection({
      status: 'active',
      accountEmail: connection.account_email,
      accountSubject: connection.account_subject,
      scopes: nextScopes,
      capabilities: connection.capabilities,
      lastError: null,
    });

    return c.json({
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      accountEmail: connection.account_email,
      scopes: nextScopes,
      profile,
    });
  } catch (error) {
    const mapped = mapGoogleRefreshError(error);
    const shouldRequireReconnect =
      mapped.code === 'invalid_grant' || mapped.code === 'deleted_client';

    if (shouldRequireReconnect) {
      await updateGoogleOAuthConnectionTokenData(db, instance.id, {
        status: 'action_required',
        lastError: `${mapped.code}: ${mapped.description}`,
        lastErrorAt: new Date().toISOString(),
      });

      await stub.updateGoogleOAuthConnection({
        status: 'action_required',
        accountEmail: connection.account_email,
        accountSubject: connection.account_subject,
        scopes: connection.scopes,
        capabilities: connection.capabilities,
        lastError: `${mapped.code}: ${mapped.description}`,
      });

      return c.json({ error: 'Google OAuth requires reconnect', reason: mapped.code }, 409);
    }

    console.error('[controller] Google OAuth refresh failed:', mapped);
    return c.json({ error: 'Google OAuth token refresh failed', reason: mapped.code }, 502);
  }
});

controller.post('/google/status', async (c: Context<AppEnv>) => {
  const rawBody: unknown = await c.req.json().catch((): unknown => null);
  const parsed = GoogleStatusRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const authorized = await authorizeGoogleControllerRequest(c, parsed.data.sandboxId);
  if ('error' in authorized) {
    return authorized.error;
  }

  const { db, instance } = authorized;
  const connection = await getGoogleOAuthConnectionByInstanceId(db, instance.id);
  if (!connection) {
    return c.json({ connected: false, accounts: [] }, 200);
  }

  const account = {
    email: connection.account_email,
    client: connection.oauth_client_id,
    services: connection.capabilities,
    scopes: connection.scopes,
    created_at: connection.connected_at,
    auth: connection.credential_profile === 'legacy' ? 'oauth-legacy' : 'oauth',
    profile: connection.credential_profile,
    status: connection.status,
  };

  return c.json({ connected: connection.status === 'active', accounts: [account] }, 200);
});

controller.post('/google/migrate-legacy', async (c: Context<AppEnv>) => {
  const rawBody: unknown = await c.req.json().catch((): unknown => null);
  const parsed = GoogleMigrateLegacyRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten().fieldErrors }, 400);
  }

  const authorized = await authorizeGoogleControllerRequest(c, parsed.data.sandboxId);
  if ('error' in authorized) {
    return authorized.error;
  }

  const { db, instance, stub } = authorized;
  const existing = await getGoogleOAuthConnectionByInstanceId(db, instance.id);

  const encryptionKey = c.env.GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return c.json({ error: 'Google OAuth broker is not configured' }, 503);
  }

  const now = new Date().toISOString();
  const scopes = [...new Set(parsed.data.scopes)].sort();
  const migratedLegacyCapabilities = normalizeCapabilities(parsed.data.capabilities);
  const existingGrants = parseGoogleGrantsBySource(existing?.grants_by_source);
  const nextLegacyGrants = normalizeCapabilities([
    ...(existingGrants.legacy ?? []),
    ...migratedLegacyCapabilities,
    ...(existing?.credential_profile === 'legacy' ? (existing.capabilities ?? []) : []),
  ]);
  const nextOauthGrants = normalizeCapabilities(existingGrants.oauth ?? []);
  const grantsBySource: GoogleGrantsBySource = {};
  if (nextLegacyGrants.length > 0) grantsBySource.legacy = nextLegacyGrants;
  if (nextOauthGrants.length > 0) grantsBySource.oauth = nextOauthGrants;
  const capabilities = effectiveGoogleCapabilities(grantsBySource);

  if (existing && existing.credential_profile === 'kilo_owned') {
    const currentGrants = parseGoogleGrantsBySource(existing.grants_by_source);
    const currentCapabilities = normalizeCapabilities(existing.capabilities ?? []);
    const sameLegacyGrants =
      JSON.stringify(currentGrants.legacy ?? []) === JSON.stringify(nextLegacyGrants);
    const sameOauthGrants =
      JSON.stringify(currentGrants.oauth ?? []) === JSON.stringify(nextOauthGrants);
    const sameCapabilities = JSON.stringify(currentCapabilities) === JSON.stringify(capabilities);

    if (existing.status === 'active' && sameLegacyGrants && sameOauthGrants && sameCapabilities) {
      return c.json({ migrated: false, reason: 'kilo_owned_already_active' }, 200);
    }
  }

  if (existing && existing.credential_profile === 'kilo_owned') {
    await db.execute(sql`
      UPDATE kiloclaw_google_oauth_connections
      SET
        grants_by_source = ${JSON.stringify(grantsBySource)}::jsonb,
        capabilities = ${sqlTextArray(capabilities)},
        updated_at = ${now}
      WHERE instance_id = ${instance.id}
    `);
  } else if (existing) {
    await updateGoogleOAuthConnectionTokenData(db, instance.id, {
      oauthClientId: parsed.data.oauthClientId,
      oauthClientSecretEncrypted: encryptWithSymmetricKey(
        parsed.data.oauthClientSecret,
        encryptionKey
      ),
      credentialProfile: 'legacy',
      refreshTokenEncrypted: encryptWithSymmetricKey(parsed.data.refreshToken, encryptionKey),
      scopes,
      status: 'active',
      lastError: null,
      lastErrorAt: null,
    });

    await db.execute(sql`
      UPDATE kiloclaw_google_oauth_connections
      SET
        account_email = ${parsed.data.accountEmail},
        account_subject = ${parsed.data.accountSubject},
        grants_by_source = ${JSON.stringify(grantsBySource)}::jsonb,
        capabilities = ${sqlTextArray(capabilities)},
        connected_at = ${now},
        updated_at = ${now}
      WHERE instance_id = ${instance.id}
    `);
  }

  // Ensure row exists if it was previously missing.
  if (!existing) {
    await db.execute(sql`
      INSERT INTO kiloclaw_google_oauth_connections (
        instance_id,
        provider,
        account_email,
        account_subject,
        oauth_client_id,
        oauth_client_secret_encrypted,
        credential_profile,
        refresh_token_encrypted,
        scopes,
        grants_by_source,
        capabilities,
        status,
        connected_at,
        created_at,
        updated_at
      ) VALUES (
        ${instance.id},
        'google',
        ${parsed.data.accountEmail},
        ${parsed.data.accountSubject},
        ${parsed.data.oauthClientId},
        ${encryptWithSymmetricKey(parsed.data.oauthClientSecret, encryptionKey)},
        'legacy',
        ${encryptWithSymmetricKey(parsed.data.refreshToken, encryptionKey)},
        ${sqlTextArray(scopes)},
        ${JSON.stringify(grantsBySource)}::jsonb,
        ${sqlTextArray(capabilities)},
        'active',
        ${now},
        ${now},
        ${now}
      )
      ON CONFLICT (instance_id)
      DO UPDATE SET
        account_email = EXCLUDED.account_email,
        account_subject = EXCLUDED.account_subject,
        oauth_client_id = EXCLUDED.oauth_client_id,
        oauth_client_secret_encrypted = EXCLUDED.oauth_client_secret_encrypted,
        credential_profile = EXCLUDED.credential_profile,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        scopes = EXCLUDED.scopes,
        grants_by_source = EXCLUDED.grants_by_source,
        capabilities = EXCLUDED.capabilities,
        status = EXCLUDED.status,
        last_error = NULL,
        last_error_at = NULL,
        connected_at = EXCLUDED.connected_at,
        updated_at = EXCLUDED.updated_at
      WHERE kiloclaw_google_oauth_connections.credential_profile <> 'kilo_owned'
    `);
  }

  const current = await getGoogleOAuthConnectionByInstanceId(db, instance.id);
  if (!current) {
    return c.json({ error: 'Google OAuth connection not found after migration write' }, 500);
  }

  let resolvedCapabilities = capabilities;
  let resolvedScopes = scopes;
  let resolvedStatus: GoogleOAuthConnectionStatus = 'active';
  let resolvedAccountEmail = parsed.data.accountEmail;
  let resolvedAccountSubject = parsed.data.accountSubject;
  let resolvedLastError: string | null = null;
  let resolvedProfile: 'legacy' | 'kilo_owned' = current.credential_profile;

  if (current.credential_profile === 'kilo_owned') {
    const currentGrants = parseGoogleGrantsBySource(current.grants_by_source);
    const mergedLegacyGrants = normalizeCapabilities([
      ...(currentGrants.legacy ?? []),
      ...migratedLegacyCapabilities,
    ]);
    const mergedOauthGrants = normalizeCapabilities(currentGrants.oauth ?? []);
    const mergedGrantsBySource: GoogleGrantsBySource = {};
    if (mergedLegacyGrants.length > 0) mergedGrantsBySource.legacy = mergedLegacyGrants;
    if (mergedOauthGrants.length > 0) mergedGrantsBySource.oauth = mergedOauthGrants;

    resolvedCapabilities = effectiveGoogleCapabilities(mergedGrantsBySource);
    resolvedScopes = [...new Set(current.scopes ?? [])].sort();
    resolvedStatus = current.status;
    resolvedAccountEmail = current.account_email;
    resolvedAccountSubject = current.account_subject;
    resolvedLastError = current.last_error ?? null;
    resolvedProfile = 'kilo_owned';

    await db.execute(sql`
      UPDATE kiloclaw_google_oauth_connections
      SET
        grants_by_source = ${JSON.stringify(mergedGrantsBySource)}::jsonb,
        capabilities = ${sqlTextArray(resolvedCapabilities)},
        updated_at = ${now}
      WHERE instance_id = ${instance.id}
    `);
  }

  await stub.updateGoogleOAuthConnection({
    status: resolvedStatus,
    accountEmail: resolvedAccountEmail,
    accountSubject: resolvedAccountSubject,
    scopes: resolvedScopes,
    capabilities: resolvedCapabilities,
    lastError: resolvedLastError,
  });

  return c.json({ migrated: true, profile: resolvedProfile }, 200);
});

export { controller };
