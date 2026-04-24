import type { Env } from './env';
import type { IngestQueueMessage } from './queue-consumer';

export { SessionIngestDO } from './dos/SessionIngestDO';
export { SessionAccessCacheDO } from './dos/SessionAccessCacheDO';
export { UserConnectionDO } from './dos/UserConnectionDO';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { app } = await import('./app');
    return app.fetch(request, env);
  },
  async queue(batch: MessageBatch<IngestQueueMessage>, env: Env): Promise<void> {
    const { queue } = await import('./queue-consumer');
    await queue(batch, env);
  },
};
