import { getScimSyncDOStub, ScimSyncDO } from './dos/ScimSyncDO';
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
      return Response.json(await getScimSyncDOStub(env).getStatus());
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
