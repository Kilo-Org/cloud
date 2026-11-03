import { getScimSyncDOStub, ScimSyncDO } from './dos/ScimSyncDO';

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
};
