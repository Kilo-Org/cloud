import { WorkOSEventSyncDO, getWorkOSEventSyncDOStub } from './dos/WorkOSEventSyncDO';
import { withDORetry } from './util/do-retry';
import { logger } from './util/logger';

export { WorkOSEventSyncDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'scim-sync' });
    }

    if (pathname === '/status') {
      const status = await withDORetry(
        () => getWorkOSEventSyncDOStub(env),
        stub => stub.getStatus(),
        'getStatus'
      );
      return Response.json(status);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  /**
   * Watchdog. The Durable Object reschedules itself after every poll, so this
   * only re-arms a loop that died (DO eviction with exhausted alarm retries).
   * `ensureScheduled` is a no-op when an alarm is already set.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await withDORetry(
      () => getWorkOSEventSyncDOStub(env),
      stub => stub.ensureScheduled(),
      'ensureScheduled'
    );
    if (result.armed) {
      logger.warn('WorkOS event sync was not scheduled; cron re-armed it', {
        nextAlarmAt: result.nextAlarmAt,
      });
    }
  },
};
