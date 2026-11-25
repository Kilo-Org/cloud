import { AUDIT_CHECKPOINT_KEYS_PATH, readPublicKeys } from './checkpoint';
import type { Env } from './env';
import { handleQueue } from './queue';
import { handleScheduled } from './scheduled';

export { RegistryDO } from './dos/RegistryDO';
export { SignerDO } from './dos/SignerDO';
export { StreamDO } from './dos/StreamDO';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      url.pathname === AUDIT_CHECKPOINT_KEYS_PATH
    ) {
      const keys = await readPublicKeys(env);
      return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=60' } });
    }
    return new Response('Not Found', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
