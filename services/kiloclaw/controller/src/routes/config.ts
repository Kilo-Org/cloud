import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import { atomicWrite } from '../atomic-write';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import { backupConfigFile, writeBaseConfig } from '../config-writer';
import { getBearerToken } from './gateway';

const ReplaceConfigBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
  etag: z.string().optional(),
});

function computeEtag(raw: string): string {
  return crypto.createHash('md5').update(raw).digest('hex');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONFIG_PATH = '/root/.openclaw/openclaw.json';

const VALID_VERSIONS = ['base'] as const;
type ConfigVersion = (typeof VALID_VERSIONS)[number];

function isValidVersion(v: string): v is ConfigVersion {
  return (VALID_VERSIONS as readonly string[]).includes(v);
}

/**
 * Deep-merge `patch` into `target`, creating intermediate objects as needed.
 * Arrays and primitives in the patch overwrite the target value.
 */
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (BANNED_KEYS.has(key)) continue;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

export function registerConfigRoutes(
  app: Hono,
  supervisor: Supervisor,
  expectedToken: string
): void {
  app.use('/_kilo/config/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Read the current openclaw.json config from disk.
  app.get('/_kilo/config/read', c => {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config = JSON.parse(raw);
      if (!isJsonObject(config)) {
        return c.json(
          { code: 'config_read_failed', error: 'Config file does not contain a JSON object' },
          500
        );
      }
      const etag = computeEtag(raw);
      return c.json({ config, etag });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[controller] /_kilo/config/read failed:', message);
      return c.json(
        { code: 'config_read_failed', error: `Failed to read config: ${message}` },
        500
      );
    }
  });

  // Restore config from env vars and restart the gateway.
  app.post('/_kilo/config/restore/:version', c => {
    const version = c.req.param('version');

    if (!isValidVersion(version)) {
      return c.json(
        { error: `Invalid config version: ${version}. Valid: ${VALID_VERSIONS.join(', ')}` },
        400
      );
    }

    try {
      writeBaseConfig(process.env);
      const gatewayState = supervisor.getState();
      const signaled = gatewayState === 'running' && supervisor.signal('SIGUSR1');
      if (!signaled) {
        console.warn(
          `[controller] Config restored but gateway is ${gatewayState} — SIGUSR1 not sent`
        );
      }
      return c.json({ ok: true, signaled });
    } catch (error) {
      console.error('[controller] /_kilo/config/restore failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: `Failed to restore config: ${message}` }, 500);
    }
  });

  // Replace openclaw.json with a JSON blob.
  //
  // Optionally accepts an etag. When provided, the write is rejected with a
  // 409 if the on-disk config has changed. This, and the underlying file op,
  // is just best effort concurrency; it's not designed against high
  // contention or tight race conditions
  app.post('/_kilo/config/replace', async c => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ code: 'invalid_json_body', error: 'Invalid JSON body' }, 400);
    }

    const parsed = ReplaceConfigBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: 'invalid_request_body', error: 'Invalid request body' }, 400);
    }

    const { config, etag } = parsed.data;

    // Best effort optimistic concurrency: the read/check/write is not atomic,
    // but sufficient to catch the common case of stale browser tabs.
    try {
      if (etag !== undefined) {
        const current = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (etag !== computeEtag(current)) {
          return c.json(
            {
              code: 'config_etag_conflict',
              error: 'Config was modified since last read — please reload and retry',
            },
            409
          );
        }
      }

      backupConfigFile(CONFIG_PATH);
      atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2));

      console.log('[controller] Config replaced');
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[controller] Failed to replace config:', message);
      return c.json(
        { code: 'config_replace_failed', error: `Failed to replace config: ${message}` },
        500
      );
    }
  });

  // Deep-merge a JSON patch into openclaw.json.
  // OpenClaw's gateway watches this file and reloads on change.
  //
  // Example: PATCH /_kilo/config/patch
  //   { "agents": { "defaults": { "model": { "primary": "kilocode/anthropic/claude-sonnet-4.5" } } } }
  app.post('/_kilo/config/patch', async c => {
    let patch: unknown;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const config = JSON.parse(raw);
      deepMerge(config, patch as Record<string, unknown>);
      const serialized = JSON.stringify(config, null, 2);
      atomicWrite(CONFIG_PATH, serialized);
      console.log('[controller] Config patched:', JSON.stringify(patch));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[controller] Failed to patch config:', message);
      return c.json({ error: `Failed to patch config: ${message}` }, 500);
    }
  });
}
