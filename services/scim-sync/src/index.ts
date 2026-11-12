import { getScimSyncDOStub, ScimSyncDO } from './dos/ScimSyncDO';
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
    // works. Anything that exposes this route later has to add authentication
    // first: it reports internal state, and reaching it drives a billable
    // Durable Object request.
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
