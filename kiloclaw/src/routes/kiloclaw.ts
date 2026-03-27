import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  SECRET_CATALOG,
  getFieldKeysByCategory,
  isCustomSecretEnvVar,
} from '@kilocode/kiloclaw-secret-catalog';
import { instrumented } from '../middleware/analytics';

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
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

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
      customSecretKeys: config.encryptedSecrets
        ? Object.keys(config.encryptedSecrets).filter(isCustomSecretEnvVar)
        : [],
      customSecretMeta: config.customSecretMeta ?? {},
    });
  })
);

// GET /api/kiloclaw/status -- user's instance status from the DO
kiloclaw.get('/status', c =>
  instrumented(c, 'GET /api/kiloclaw/status', async () => {
    const userId = c.get('userId');
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

    const status = await stub.getStatus();

    return c.json(status);
  })
);

// GET /api/kiloclaw/chat-credentials -- Stream Chat credentials for the user's channel
kiloclaw.get('/chat-credentials', c =>
  instrumented(c, 'GET /api/kiloclaw/chat-credentials', async () => {
    const userId = c.get('userId');
    const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

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
    result[entry.id] = entry.fields.every(field => {
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
