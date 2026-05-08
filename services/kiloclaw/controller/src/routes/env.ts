import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import { migrateKilocodeAuthProfilesToKeyRef } from '../auth-profiles-migration';
import type { AuthProfilesMigrationReport } from '../auth-profiles-migration';
import { getBearerToken } from './gateway';

const PATCHABLE_KEYS = new Set(['KILOCODE_API_KEY']);
const OPENCLAW_STATE_DIR = '/root/.openclaw';

export type EnvRoutesDeps = {
  migrate: (rootDir: string) => AuthProfilesMigrationReport;
};

const defaultDeps: EnvRoutesDeps = {
  migrate: rootDir => migrateKilocodeAuthProfilesToKeyRef(rootDir),
};

/**
 * Rotate the KiloCode API key in the live gateway.
 *
 * The gateway runs in a child process with a frozen copy of the controller's
 * environment — updating `process.env.KILOCODE_API_KEY` in the controller
 * does not reach the child. Two openclaw mechanisms that look like they
 * should help are both no-ops in our setup:
 *
 *   1. `openclaw secrets reload` re-resolves SecretRefs against the
 *      gateway's OWN `process.env` (frozen at spawn time), so it returns
 *      "success" with the stale value and never picks up the new env.
 *   2. SIGUSR1 (with `OPENCLAW_NO_RESPAWN=1`, which the bootstrap sets)
 *      takes the "in-process restart" branch — the gateway process stays
 *      alive and re-initializes against the same frozen env.
 *
 * The only thing that actually rotates the key is a full process exit so
 * the controller's supervisor respawns the gateway, inheriting the
 * controller's current `process.env`. `supervisor.restart()` (SIGTERM →
 * child exit → respawn) does exactly that. After the respawn, the gateway
 * reads the already-migrated `auth-profiles.json` (which now carries a
 * `keyRef`) and resolves it against the fresh env.
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

    // Fire-and-forget the restart so the HTTP request doesn't block on
    // gateway lifecycle (~5-10s). The old SIGUSR1 signal was also
    // fire-and-forget; we keep the same request semantics here. Errors
    // are logged; the supervisor will eventually reach a terminal state.
    //
    // The response field is named `signaled` for wire compatibility with
    // the worker (`EnvPatchResponseSchema` in gateway-controller-types.ts
    // and `reconcile.ts` which uses `result?.signaled` as the success
    // bit for live env delivery). The semantics are unchanged — the
    // controller delivered the env change to the running gateway — only
    // the mechanism changed from SIGUSR1 to a full restart.
    let signaled = false;
    if (supervisor.getState() === 'running') {
      signaled = true;
      void supervisor.restart().catch(err => {
        console.error('[controller] gateway restart failed during rotation:', err);
      });
    }

    console.log(
      '[controller] Env patched:',
      entries.map(([k]) => k).join(', '),
      'signaled:',
      signaled,
      'migratedProfiles:',
      migrationReport.profilesMigrated
    );
    return c.json({
      ok: true,
      signaled,
      migratedProfiles: migrationReport.profilesMigrated,
    });
  });
}
