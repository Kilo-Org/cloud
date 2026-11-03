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

    // Diagnostic only, and not reachable in production: this Worker has
    // `workers_dev: false`, no `routes`, and no inbound service binding, so
    // nothing can issue an HTTP request to it once deployed. It answers under
    // `wrangler dev`, where the response proves the Durable Object namespace
    // and the Hyperdrive binding both work. Anything that exposes this route
    // later has to add authentication first: it reports internal state and
    // reaching it drives a billable Durable Object request and a database
    // query.
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
 *
 * The failure detail goes to Workers Logs, not the response. A driver error
 * carries the failing SQL and its parameters, which is useful in a log and
 * wrong in a body that may one day be exposed; the response says only whether
 * the database answered.
 */
async function checkDatabase(env: Env): Promise<DatabaseStatus> {
  const startedAt = Date.now();
  try {
    const organizationCount = await countOrganizations(getPgDb(env));
    return { reachable: true, organizationCount, latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error('Database reachability check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { reachable: false, organizationCount: null, latencyMs: Date.now() - startedAt };
  }
}
