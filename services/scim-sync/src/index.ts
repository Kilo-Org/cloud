import { countOrganizations } from './db/organizations';
import { getPgDb } from './db/pg';
import { getScimSyncDOStub, ScimSyncDO } from './dos/ScimSyncDO';
import type { DatabaseStatus } from './types';
import { logger } from './util/logger';

export { ScimSyncDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'scim-sync' });
    }

    // Calls the Durable Object, so a 200 proves the namespace is reachable and
    // not merely that the Worker booted. Unauthenticated, which is why the
    // Worker publishes no public URL: see `workers_dev` in wrangler.jsonc.
    if (pathname === '/status') {
      const [doStatus, database] = await Promise.all([
        getScimSyncDOStub(env).getStatus(),
        checkDatabase(env),
      ]);
      return Response.json({ ...doStatus, database });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  /**
   * Watchdog. The Durable Object reschedules itself after every poll, so this
   * only matters when that chain dies — an eviction with exhausted alarm
   * retries. `ensureScheduled` leaves a live alarm alone.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const { armed, nextAlarmAt } = await getScimSyncDOStub(env).ensureScheduled();
    if (armed) {
      logger.warn('SCIM sync was not scheduled; cron re-armed it', { nextAlarmAt });
    }
  },
};

/**
 * Proves the Hyperdrive binding reaches the shared PostgreSQL, by counting the
 * table this service actually reads. Reports the failure instead of raising it:
 * `/status` is a diagnostic, and a database outage should be visible in the
 * response rather than collapsing it into a 500.
 */
async function checkDatabase(env: Env): Promise<DatabaseStatus> {
  const startedAt = Date.now();
  try {
    const organizationCount = await countOrganizations(getPgDb(env));
    return { reachable: true, organizationCount, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Database reachability check failed', { error: message });
    return {
      reachable: false,
      organizationCount: null,
      latencyMs: Date.now() - startedAt,
      error: message,
    };
  }
}
