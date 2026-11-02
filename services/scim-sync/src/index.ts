import { timingSafeEqual } from 'node:crypto';

import { getScimSyncDOStub, ScimSyncDO } from './dos/ScimSyncDO';

export { ScimSyncDO };

/**
 * `node:crypto`'s `timingSafeEqual` throws on a length mismatch, so the length
 * guard runs a dummy comparison to keep timing from leaking the length.
 * Mirrors `packages/encryption/src/timing-safe-equal.ts`, inlined because this
 * Worker has no other reason to depend on that package.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Public liveness. Never touches the Durable Object, so an external monitor
    // cannot drive billable Durable Object requests.
    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'scim-sync' });
    }

    // Calls the Durable Object, so a 200 proves the namespace is reachable and
    // not merely that the Worker booted. `workers_dev` publishes this Worker on
    // the public internet, so the shared internal secret is checked first: an
    // unauthenticated caller costs a Secrets Store read, never a Durable Object
    // request. Same header and binding as `services/notifications`.
    if (pathname === '/status') {
      const provided = request.headers.get('X-Internal-Secret');
      const expected = await env.INTERNAL_API_SECRET.get();
      if (!provided || !expected || !secretMatches(provided, expected)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      return Response.json(await getScimSyncDOStub(env).getStatus());
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
