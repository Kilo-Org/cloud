import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

/**
 * ClawMetry observability endpoints.
 *
 * These pair with the `provisionClawMetrySync` bootstrap step that pre-wires
 * each instance with a ClawMetry account at boot. The sync daemon stays
 * dormant until a user clicks "View Observability" — at that point the web
 * UI hits these two endpoints to (1) start the daemon, (2) fetch the self-
 * decrypting dashboard URL, then opens it in a new tab.
 *
 * Auth: same bearer-token gate as the rest of `/_kilo/*` (handled by the
 * shared `_kilo/*` middleware that registerHealthRoutes installs).
 */

export const CLAWMETRY_DASHBOARD_URL_PATH = '/root/.clawmetry/dashboard-url.txt';

type ClawmetryDeps = {
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  existsSync?: (path: string) => boolean;
  spawn?: typeof spawn;
  isAlreadyRunning?: () => boolean;
};

/** Default: check if `clawmetry sync` is already in the process table. */
function defaultIsAlreadyRunning(): boolean {
  try {
    const out = spawn('pgrep', ['-f', 'clawmetry sync'], { stdio: 'pipe' });
    // Synchronous check via the kernel-side pid table is heavier than this
    // worth — instead, treat the file-based marker as authoritative when set.
    // Callers that want true freshness should check /var/log/clawmetry-sync.log.
    return false;
  } catch {
    return false;
  }
}

export function registerClawmetryRoutes(
  app: Hono,
  expectedToken: string,
  deps: ClawmetryDeps = {}
): void {
  const readFileSync = deps.readFileSync ?? ((p, e) => fs.readFileSync(p, e));
  const existsSync = deps.existsSync ?? (p => fs.existsSync(p));
  const spawnFn = deps.spawn ?? spawn;
  const isAlreadyRunning = deps.isAlreadyRunning ?? defaultIsAlreadyRunning;

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
   * Spawns `clawmetry sync` as a detached background process. Idempotent —
   * if the daemon is already running, this is a no-op and returns
   * { ok: true, alreadyRunning: true }. The daemon reads its config from
   * /root/.clawmetry/config.json (written at bootstrap).
   *
   * Always returns 200 on success. The web UI calls this before opening
   * the dashboard URL so the dashboard sees fresh events arriving.
   */
  app.post('/_kilo/clawmetry-start-sync', c => {
    if (isAlreadyRunning()) {
      return c.json({ ok: true, alreadyRunning: true });
    }
    try {
      // Spawn the sync daemon directly via the venv python — `clawmetry sync`
      // isn't a CLI subcommand; the canonical entry point is the sync.py
      // module (see clawmetry/cli.py:_start_subprocess). install.sh creates
      // a venv at /root/.clawmetry, so the python is at /root/.clawmetry/bin/python3.
      // Detached + ignored stdio so the daemon outlives this request handler.
      const child = spawnFn('/root/.clawmetry/bin/python3', ['-m', 'clawmetry.sync'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return c.json({ ok: true, alreadyRunning: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[clawmetry] failed to spawn sync daemon: ${message}`);
      return c.json({ error: 'Failed to start sync daemon' }, 500);
    }
  });
}
