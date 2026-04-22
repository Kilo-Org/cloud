import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  SECRET_CATALOG,
  getFieldKeysByCategory,
  isCustomSecretEnvVar,
} from '@kilocode/kiloclaw-secret-catalog';
import { instrumented } from '../middleware/analytics';
import { InstanceIdParam } from '../schemas/instance-config';

/** Channel env var names — excluded from secretCount (channels have their own counts). */
const CHANNEL_ENV_VARS = new Set(
  SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.envVar))
);

/** Channel field keys — used to check legacy `channels` storage for backward compat. */
const CHANNEL_FIELD_KEYS = getFieldKeysByCategory('channel');

/**
 * User-facing KiloClaw routes (JWT auth via authMiddleware).
 *
 * These routes allow a user to inspect their own instance via the
 * KiloClawInstance DO. They expose safe read-only views -- no secret
 * values, no lifecycle mutations (those go through /api/platform).
 */
const kiloclaw = new Hono<AppEnv>();

// GET /api/kiloclaw/config -- user's current env var keys, secret count, channel status
kiloclaw.get('/config', c =>
  instrumented(c, 'GET /api/kiloclaw/config', async () => {
    const userId = c.get('userId');
    const raw = c.req.query('instanceId');
    if (raw && !InstanceIdParam.safeParse(raw).success) {
      return c.json({ error: 'Invalid instance ID' }, 400);
    }
    const instanceId = raw || undefined;
    const doKey = instanceId ?? userId;
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));

    // When accessing by instanceId, verify the authenticated user owns this instance.
    if (instanceId) {
      const status = await stub.getStatus();
      if (status.userId !== userId) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    const config = await stub.getConfig();

    return c.json({
      envVarKeys: config.envVars ? Object.keys(config.envVars) : [],
      secretCount: config.encryptedSecrets
        ? Object.keys(config.encryptedSecrets).filter(k => !CHANNEL_ENV_VARS.has(k)).length
        : 0,
      kilocodeDefaultModel: config.kilocodeDefaultModel ?? null,
      hasKiloCodeApiKey: !!config.kilocodeApiKey,
      kilocodeApiKeyExpiresAt: config.kilocodeApiKeyExpiresAt ?? null,
      configuredSecrets: buildConfiguredSecrets(config),
      kiloExaSearchMode: config.webSearch?.exaMode ?? null,
      customSecretKeys: config.encryptedSecrets
        ? Object.keys(config.encryptedSecrets).filter(isCustomSecretEnvVar)
        : [],
      customSecretMeta: config.customSecretMeta ?? {},
      vectorMemoryEnabled: config.vectorMemoryEnabled ?? false,
      vectorMemoryModel: config.vectorMemoryModel ?? null,
      dreamingEnabled: config.dreamingEnabled ?? false,
    });
  })
);

// GET /api/kiloclaw/status -- user's instance status from the DO
kiloclaw.get('/status', c =>
  instrumented(c, 'GET /api/kiloclaw/status', async () => {
    const userId = c.get('userId');
    const raw = c.req.query('instanceId');
    if (raw && !InstanceIdParam.safeParse(raw).success) {
      return c.json({ error: 'Invalid instance ID' }, 400);
    }
    const instanceId = raw || undefined;
    const doKey = instanceId ?? userId;
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));

    const status = await stub.getStatus();

    // When accessing by instanceId, verify the authenticated user owns this instance.
    if (instanceId && status.userId !== userId) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json(status);
  })
);

// GET /api/kiloclaw/chat-credentials -- Stream Chat credentials for the user's channel
kiloclaw.get('/chat-credentials', c =>
  instrumented(c, 'GET /api/kiloclaw/chat-credentials', async () => {
    const userId = c.get('userId');
    const raw = c.req.query('instanceId');
    if (raw && !InstanceIdParam.safeParse(raw).success) {
      return c.json({ error: 'Invalid instance ID' }, 400);
    }
    const instanceId = raw || undefined;
    const doKey = instanceId ?? userId;
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(doKey));

    // When accessing by instanceId, verify the authenticated user owns this instance.
    if (instanceId) {
      const status = await stub.getStatus();
      if (status.userId !== userId) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    const creds = await stub.getStreamChatCredentials();

    return c.json(creds);
  })
);

/**
 * Derive per-entry configured status from the catalog.
 *
 * Checks both `encryptedSecrets` (new path) and legacy `channels` storage
 * so that instances provisioned before the catalog migration still report
 * correct status. An entry is "configured" when ALL its fields have a value.
 */
function buildConfiguredSecrets(config: {
  encryptedSecrets?: Record<string, unknown> | null;
  channels?: Record<string, unknown> | null;
}): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  for (const entry of SECRET_CATALOG) {
    const requiredFields = entry.fields.filter(field => field.requiredForConfigured !== false);
    const fieldsToCheck = requiredFields.length > 0 ? requiredFields : entry.fields;
    result[entry.id] = fieldsToCheck.every(field => {
      // Check new encryptedSecrets storage (keyed by env var name)
      if (config.encryptedSecrets?.[field.envVar] != null) return true;
      // Fall back to legacy channels storage (keyed by field key)
      if (CHANNEL_FIELD_KEYS.has(field.key) && config.channels?.[field.key] != null) return true;
      return false;
    });
  }

  return result;
}

export { kiloclaw, buildConfiguredSecrets };
