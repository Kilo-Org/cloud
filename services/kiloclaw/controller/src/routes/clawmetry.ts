import fs from 'node:fs';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

/**
 * ClawMetry observability endpoints.
 *
 * These pair with the `provisionClawMetrySync` bootstrap step that pre-wires
 * each instance with a ClawMetry account at boot AND spawns the daemon. The
 * daemon heartbeats every 60s but uploads zero session / event / log /
 * memory data because the cloud responds to /ingest/heartbeat with
 * sync_allowed=false, reason='intent_pending' (see clawmetry-cloud's
 * deferred-sync gate).
 *
 * When the user clicks "View Observability" in the KiloClaw web UI:
 *   1. The web UI POSTs /_kilo/clawmetry-start-sync (this file).
 *   2. We POST to ClawMetry's /api/cloud/intent-start, flipping the
 *      cloud-side flag for this account.
 *   3. We GET /_kilo/clawmetry-dashboard-url and return the URL.
 *   4. The web UI opens that URL in a new tab.
 *   5. The daemon's next heartbeat (~60s) sees sync_allowed=true and
 *      uploads resume — sessions / events / logs / memory all start
 *      flowing.
 *
 * Auth: same bearer-token gate as the rest of `/_kilo/*`.
 */

export const CLAWMETRY_DASHBOARD_URL_PATH = '/root/.clawmetry/dashboard-url.txt';
export const CLAWMETRY_CONFIG_PATH = '/root/.clawmetry/config.json';

type IntentStartFn = (apiKey: string) => Promise<{ ok: boolean; alreadyStarted?: boolean }>;

type ClawmetryDeps = {
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  existsSync?: (path: string) => boolean;
  intentStart?: IntentStartFn;
  apiBase?: string;
};

/** POST to ClawMetry's /api/cloud/intent-start. Flips the deferred-sync gate. */
async function defaultIntentStart(
  apiBase: string,
  apiKey: string
): Promise<{
  ok: boolean;
  alreadyStarted?: boolean;
}> {
  const res = await fetch(`${apiBase}/api/cloud/intent-start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`intent-start returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { ok?: boolean; already_started?: boolean };
  return { ok: !!body.ok, alreadyStarted: !!body.already_started };
}

export function registerClawmetryRoutes(
  app: Hono,
  expectedToken: string,
  deps: ClawmetryDeps = {}
): void {
  const readFileSync = deps.readFileSync ?? ((p, e) => fs.readFileSync(p, e));
  const existsSync = deps.existsSync ?? (p => fs.existsSync(p));
  const apiBase = deps.apiBase ?? process.env.CLAWMETRY_API_BASE ?? 'https://app.clawmetry.com';
  const intentStart: IntentStartFn =
    deps.intentStart ?? (apiKey => defaultIntentStart(apiBase, apiKey));

  // Shared bearer-token gate for both endpoints.
  app.use('/_kilo/clawmetry-dashboard-url', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });
  app.use('/_kilo/clawmetry-start-sync', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  /**
   * GET /_kilo/clawmetry-dashboard-url
   *
   * Returns the self-decrypting dashboard URL written at bootstrap time.
   * The URL contains a `#fragment` with the AES-256-GCM enc_key — never
   * sent to any server (browsers strip fragments from outgoing requests).
   *
   * 404 means bootstrap hasn't run yet OR ClawMetry was disabled via
   * KILOCLAW_CLAWMETRY_DISABLED. The caller should surface a friendly
   * "ClawMetry not provisioned on this instance" error.
   */
  app.get('/_kilo/clawmetry-dashboard-url', c => {
    if (!existsSync(CLAWMETRY_DASHBOARD_URL_PATH)) {
      return c.json(
        { error: 'ClawMetry dashboard URL not found — provisioning may not have run' },
        404
      );
    }
    try {
      const url = readFileSync(CLAWMETRY_DASHBOARD_URL_PATH, 'utf8').trim();
      if (!url) {
        return c.json({ error: 'Dashboard URL file is empty' }, 500);
      }
      return c.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[clawmetry] failed to read dashboard URL: ${message}`);
      return c.json({ error: 'Failed to read dashboard URL' }, 500);
    }
  });

  /**
   * POST /_kilo/clawmetry-start-sync
   *
   * The daemon is already running (spawned at bootstrap) but in deferred
   * mode — heartbeats only, no uploads. This endpoint signals user intent
   * to the ClawMetry cloud, which flips the gate so the daemon's next
   * heartbeat (~60s) returns sync_allowed=true and content uploads resume.
   *
   * Idempotent: hitting this multiple times is a no-op after the first
   * success — the cloud's intent-start endpoint short-circuits when
   * users.sync_intent_at is already set.
   *
   * Returns { ok: true, alreadyStarted: bool }. The web UI calls this
   * before opening the dashboard URL so by the time the user starts
   * looking, the daemon's first content sync is at most ~60s away.
   */
  app.post('/_kilo/clawmetry-start-sync', async c => {
    if (!existsSync(CLAWMETRY_CONFIG_PATH)) {
      return c.json({ error: 'ClawMetry config not found — provisioning may not have run' }, 404);
    }
    let apiKey: string;
    try {
      const config = JSON.parse(readFileSync(CLAWMETRY_CONFIG_PATH, 'utf8')) as {
        api_key?: string;
      };
      if (!config.api_key) {
        return c.json({ error: 'ClawMetry config missing api_key' }, 500);
      }
      apiKey = config.api_key;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[clawmetry] failed to read config: ${message}`);
      return c.json({ error: 'Failed to read ClawMetry config' }, 500);
    }
    try {
      const result = await intentStart(apiKey);
      return c.json({ ok: true, alreadyStarted: !!result.alreadyStarted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[clawmetry] intent-start failed: ${message}`);
      return c.json({ error: 'Failed to start sync' }, 502);
    }
  });
}
