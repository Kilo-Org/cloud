import { execFile } from 'node:child_process';
import type { Context, Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import { CONTROLLER_COMMIT, CONTROLLER_VERSION } from '../version';
import { getBearerToken } from './gateway';

/** Parsed result from `openclaw --version` (e.g. "OpenClaw 2026.3.8 (3caab92)"). */
type OpenclawVersionInfo = { version: string | null; commit: string | null };

const OPENCLAW_VERSION_RE = /(\d{4}\.\d{1,2}\.\d{1,2})(?:\s+\(([0-9a-f]+)\))?/;

export function parseOpenclawVersion(raw: string): OpenclawVersionInfo {
  const match = raw.match(OPENCLAW_VERSION_RE);
  if (!match) return { version: null, commit: null };
  return { version: match[1], commit: match[2] ?? null };
}

/**
 * Resolve the installed openclaw version once and cache it for the process lifetime.
 * If the user upgrades openclaw while the controller is running, the cached value
 * becomes stale until the next redeploy (which restarts the controller process).
 * This is acceptable: the UI shows a "Modified" badge by comparing image vs running
 * version, and spawning a subprocess on every request is not worth the cost.
 */
let openclawVersionPromise: Promise<OpenclawVersionInfo> | undefined;
function getOpenclawVersion(): Promise<OpenclawVersionInfo> {
  if (!openclawVersionPromise) {
    openclawVersionPromise = new Promise(resolve => {
      execFile(
        '/usr/bin/env',
        ['HOME=/root', 'openclaw', '--version'],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            resolve({ version: null, commit: null });
          } else {
            resolve(parseOpenclawVersion(stdout.toString().trim()));
          }
        }
      );
    });
  }
  return openclawVersionPromise;
}

export function registerHealthRoute(
  app: Hono,
  supervisor: Supervisor,
  expectedToken?: string
): void {
  // Eagerly resolve so the first /_kilo/version request doesn't wait on the subprocess.
  getOpenclawVersion();

  const handler = (c: Context) => c.json({ status: 'ok' });

  // Public Fly health probe endpoint. Keep response intentionally minimal.
  app.get('/_kilo/health', handler);
  // Compatibility alias to match the same minimal, public health response.
  app.get('/health', handler);

  // Authenticated version/diagnostics endpoint.
  app.get('/_kilo/version', async c => {
    if (expectedToken) {
      const token = getBearerToken(c.req.header('authorization'));
      if (!timingSafeTokenEqual(token, expectedToken)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const openclaw = await getOpenclawVersion();
    return c.json({
      version: CONTROLLER_VERSION,
      commit: CONTROLLER_COMMIT,
      openclawVersion: openclaw.version,
      openclawCommit: openclaw.commit,
      gateway: supervisor.getStats(),
    });
  });
}
