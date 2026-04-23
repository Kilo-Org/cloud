import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import { migrateKilocodeAuthProfilesToKeyRef } from '../auth-profiles-migration';
import type { AuthProfilesMigrationReport } from '../auth-profiles-migration';
import { reloadGatewaySecrets } from '../gateway-rpc';
import type { ReloadGatewaySecretsResult } from '../gateway-rpc';
import { getBearerToken } from './gateway';

const PATCHABLE_KEYS = new Set(['KILOCODE_API_KEY']);
const OPENCLAW_STATE_DIR = '/root/.openclaw';

export type EnvRoutesDeps = {
  migrate: (rootDir: string) => AuthProfilesMigrationReport;
  reload: (token: string) => ReloadGatewaySecretsResult;
};

const defaultDeps: EnvRoutesDeps = {
  migrate: rootDir => migrateKilocodeAuthProfilesToKeyRef(rootDir),
  reload: token => reloadGatewaySecrets({ token }),
};

/**
 * Rotate the KiloCode API key in the live gateway.
 *
 * Preferred path: migrate any stale plaintext kilocode profile to a keyRef
 * (idempotent; only rewrites on legacy instances), then call
 * `openclaw secrets reload` so the gateway re-resolves the env-backed
 * keyRef against the new `process.env.KILOCODE_API_KEY` value without
 * restarting.
 *
 * Fallback: if the gateway is not reachable (degraded/not running yet)
 * the reload call fails — we then signal SIGUSR1 to the supervised
 * gateway process. SIGUSR1 is a full restart; it aborts in-flight agent
 * work and tears down channels, so it's a worse experience than reload
 * but guarantees the new env var is picked up on re-spawn.
 */
export function registerEnvRoutes(
  app: Hono,
  supervisor: Supervisor,
  expectedToken: string,
  deps: EnvRoutesDeps = defaultDeps
): void {
  app.use('/_kilo/env/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/_kilo/env/patch', async c => {
    let patch: unknown;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length === 0) {
      return c.json({ error: 'Body must contain at least one key' }, 400);
    }

    const validated: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!PATCHABLE_KEYS.has(key)) {
        return c.json({ error: `Key '${key}' is not patchable` }, 400);
      }
      if (typeof value !== 'string') {
        return c.json({ error: `Value for '${key}' must be a string` }, 400);
      }
      validated[key] = value;
    }

    for (const [key, value] of Object.entries(validated)) {
      process.env[key] = value;
    }

    const migrationReport = deps.migrate(OPENCLAW_STATE_DIR);

    let reloaded = false;
    let signaled = false;
    if (supervisor.getState() === 'running') {
      const reloadResult = deps.reload(expectedToken);
      if (reloadResult.ok) {
        reloaded = true;
      } else {
        // `reloadResult.error` is already redacted in `reloadGatewaySecrets`,
        // but strip the token again here as defense-in-depth: a future caller
        // or a refactor must not be able to leak the gateway token into
        // controller logs through this path (see AGENTS.md). The 8-char floor
        // mirrors `gateway-rpc.ts` and avoids mangling unrelated text with
        // coincidental substrings when tokens are abnormally short.
        const safeReason =
          expectedToken.length >= 8
            ? reloadResult.error.split(expectedToken).join('<redacted-token>')
            : reloadResult.error;
        console.warn(
          '[controller] openclaw secrets reload failed, falling back to SIGUSR1:',
          safeReason
        );
        signaled = supervisor.signal('SIGUSR1');
      }
    }

    console.log(
      '[controller] Env patched:',
      entries.map(([k]) => k).join(', '),
      'reloaded:',
      reloaded,
      'signaled:',
      signaled,
      'migratedProfiles:',
      migrationReport.profilesMigrated
    );
    return c.json({
      ok: true,
      reloaded,
      signaled,
      migratedProfiles: migrationReport.profilesMigrated,
    });
  });
}
