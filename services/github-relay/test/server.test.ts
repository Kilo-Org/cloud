import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayRequest } from '../src/relay';
import { createRelayServer } from '../src/server';

type Answer = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

let server: Server | null = null;

afterEach(async () => {
  const open = server;
  server = null;
  vi.restoreAllMocks();
  if (open !== null) await new Promise<void>(resolve => open.close(() => resolve()));
});

/** Starts the adapter on a loopback port with `handle`, and records what it was given. */
async function start(handle: (request: RelayRequest) => Promise<Response>) {
  const seen: RelayRequest[] = [];
  server = createRelayServer(async request => {
    seen.push(request);
    return await handle(request);
  });
  const listening = server;
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', () => resolve()));
  const { port } = listening.address() as AddressInfo;
  return { port, seen };
}

/** One raw HTTP/1.1 exchange, so the test controls the method, headers and body exactly. */
function send(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string | string[]>;
    body?: string;
  }
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('the relay server', () => {
  it('hands the method, target and every header to the relay, and writes its answer back', async () => {
    const { port, seen } = await start(
      async () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json', etag: '"e"' },
        })
    );
    const answer = await send(port, {
      path: '/migration-proxy/repos/Kilo-Org/cloud/commits?per_page=1',
      headers: {
        'kilo-relay-authorization': 'Bearer sts',
        authorization: 'token gh',
        'x-multi': ['a', 'b'],
      },
    });
    expect(answer).toMatchObject({ status: 201, body: '{"ok":true}' });
    expect(answer.headers.etag).toBe('"e"');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      target: '/migration-proxy/repos/Kilo-Org/cloud/commits?per_page=1',
      hasBody: false,
    });
    expect(seen[0].headers.get('kilo-relay-authorization')).toBe('Bearer sts');
    expect(seen[0].headers.get('authorization')).toBe('token gh');
    expect(seen[0].headers.get('x-multi')).toBe('a, b');
  });

  it.each([
    ['a content length', { 'content-length': '5' }],
    ['a chunked body', { 'transfer-encoding': 'chunked' }],
  ])('marks a request with %s as having a body, and still answers it', async (_label, headers) => {
    const { port, seen } = await start(async () => new Response(null, { status: 400 }));
    const answer = await send(port, {
      method: 'POST',
      path: '/migration-proxy/x',
      headers,
      body: 'hello',
    });
    expect(answer.status).toBe(400);
    expect(seen[0].hasBody).toBe(true);
  });

  it('answers 500 without detail when the relay throws, and keeps serving', async () => {
    let calls = 0;
    const { port } = await start(async () => {
      calls += 1;
      if (calls === 1) throw new Error('token ghs_secret in a message');
      return new Response('ok');
    });
    const failed = await send(port, { path: '/migration-proxy/x' });
    expect(failed).toMatchObject({ status: 500, body: '{"error":"internal_error"}' });
    expect((await send(port, { path: '/migration-proxy/x' })).status).toBe(200);
  });

  it('aborts the relay call when the caller goes away before the answer is written', async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const { port } = await start(request => {
      request.signal.addEventListener('abort', () => aborted.resolve());
      started.resolve();
      return Promise.withResolvers<Response>().promise;
    });
    const req = httpRequest({ host: '127.0.0.1', port, path: '/migration-proxy/x' });
    req.on('error', () => undefined);
    req.end();
    await started.promise;
    req.destroy();
    await aborted.promise;
  });

  it('writes nothing to stdout or stderr itself', async () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const { port } = await start(async () => {
      throw new Error('token ghs_secret');
    });
    await send(port, {
      path: '/migration-proxy/x',
      headers: { authorization: 'token ghs_secret' },
    });
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
