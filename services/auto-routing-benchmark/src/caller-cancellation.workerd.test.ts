import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig, unstable_startWorker } from 'wrangler';

type HeldRequest = { response: ServerResponse; closed: Promise<void> };

it('closes a Durable Object subrequest when the caller goes away under the service flags', async () => {
  const held = new Map<string, HeldRequest>();
  const upstream = createServer((request, response) => {
    const closed = Promise.withResolvers<void>();
    response.once('close', () => closed.resolve());
    request.resume();
    held.set(new URL(request.url ?? '/', 'http://upstream').pathname, {
      response,
      closed: closed.promise,
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const service = unstable_readConfig({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
  });
  const worker = await unstable_startWorker({
    config: fileURLToPath(
      new URL('../test/fixtures/caller-cancellation/wrangler.jsonc', import.meta.url).href
    ),
    compatibilityDate: service.compatibility_date,
    compatibilityFlags: service.compatibility_flags,
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false },
  });
  try {
    await worker.ready;
    const callerLeavesMidRequest = async (path: '/relay' | '/direct') => {
      const target = new URL(path, 'http://fixture.test');
      target.searchParams.set('upstream', `${upstreamUrl}${path}`);
      // The fixture caller leaves after this real delay: workerd runs on its own clock.
      target.searchParams.set('leaveAfterMs', '1000');
      const response = await worker.fetch(target.toString());
      expect(await response.text()).toBe('caller gone');
    };
    await Promise.all([callerLeavesMidRequest('/relay'), callerLeavesMidRequest('/direct')]);

    const relayed = held.get('/relay');
    const direct = held.get('/direct');
    if (!relayed || !direct) throw new Error('Expected both subrequests to reach the upstream');
    await relayed.closed;
    expect(relayed.response.writableEnded).toBe(false);
    expect(direct.response.destroyed).toBe(false);
    direct.response.end('answered');
    await once(direct.response, 'finish');
  } finally {
    await worker.dispose();
    upstream.closeAllConnections();
    upstream.close();
  }
}, 30_000);
