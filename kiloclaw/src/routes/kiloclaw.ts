import { Hono } from 'hono';
import type { AppEnv } from '../types';

/**
 * User-facing KiloClaw routes (JWT auth via authMiddleware).
 *
 * These routes allow a user to inspect their own instance via the
 * KiloClawInstance DO. They expose safe read-only views -- no secret
 * values, no lifecycle mutations (those go through /api/platform).
 */
const kiloclaw = new Hono<AppEnv>();

// GET /api/kiloclaw/config -- user's current env var keys, secret count, channel status
kiloclaw.get('/config', async c => {
  const userId = c.get('userId');
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

  const config = await stub.getConfig();

  return c.json({
    envVarKeys: config.envVars ? Object.keys(config.envVars) : [],
    secretCount: config.encryptedSecrets ? Object.keys(config.encryptedSecrets).length : 0,
    channels: {
      telegram: !!config.channels?.telegramBotToken,
      discord: !!config.channels?.discordBotToken,
      slackBot: !!config.channels?.slackBotToken,
      slackApp: !!config.channels?.slackAppToken,
    },
  });
});

// GET /api/kiloclaw/status -- user's instance status from the DO
kiloclaw.get('/status', async c => {
  const userId = c.get('userId');
  const stub = c.env.KILOCLAW_INSTANCE.get(c.env.KILOCLAW_INSTANCE.idFromName(userId));

  const status = await stub.getStatus();

  return c.json(status);
});

export { kiloclaw };
