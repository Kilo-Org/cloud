import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { remoteArtifactStore } from '../../scripts/runtime-ci-store.js';
import { sha256 } from '../../scripts/publish-runtime.js';
import { publishArtifactObject } from '../../src/sandbox-control/runtime-artifact-store.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('uses conditional S3 writes and preserves the existing object during concurrent publication', async () => {
  const objects = new Map<string, Buffer>();
  const conditions: string[] = [];
  let puts = 0;
  const heads: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    const key = request.url ?? '';
    if (request.method === 'HEAD' && objects.size === 0) {
      heads.push(response);
      if (heads.length === 2) for (const pending of heads) pending.writeHead(404).end();
      return;
    }
    if (request.method === 'PUT') {
      puts += 1;
      conditions.push(String(request.headers['if-none-match']));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200).end();
      return;
    }
    const bytes = objects.get(key);
    response.writeHead(bytes ? 200 : 404);
    response.end(request.method === 'GET' ? bytes : undefined);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  const request: typeof fetch = async (input, init) => {
    if (!(input instanceof Request)) throw new Error('store did not sign its request');
    const url = new URL(input.url);
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, {
      method: input.method,
      headers: input.headers,
      signal: init?.signal,
      ...(input.method === 'PUT' ? { body: await input.arrayBuffer() } : {}),
    });
  };
  const store = remoteArtifactStore({
    accountId: 'a'.repeat(32),
    bucket: 'test-runtime',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    request,
  });
  const bytes = new TextEncoder().encode('same immutable payload');
  const input = { sha256: sha256(bytes), bytes };
  const results = await Promise.all([
    publishArtifactObject(store, input),
    publishArtifactObject(store, input),
  ]);
  expect(results.filter(result => result.created)).toHaveLength(1);
  expect(puts).toBe(2);
  expect(conditions.every(condition => condition === '*')).toBe(true);
  expect(objects.size).toBe(1);
  const writes = puts;
  expect((await publishArtifactObject(store, input)).created).toBe(false);
  expect(puts).toBe(writes);
  expect([...objects.values()][0]).toEqual(Buffer.from(bytes));
});

it('treats denied reads as failures, not cache misses, and does not expose credentials', async () => {
  const store = remoteArtifactStore({
    accountId: 'a'.repeat(32),
    bucket: 'test-runtime',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'do-not-expose-this-secret',
    request: async () => new Response(null, { status: 403 }),
  });
  await expect(store.getBytes(`runtime-artifacts/v1/objects/${'b'.repeat(64)}`)).rejects.toThrow(
    'GET failed (403)'
  );
  await expect(
    store.putIfAbsent(
      `runtime-artifacts/v1/objects/${'b'.repeat(64)}`,
      new Uint8Array(),
      'application/json'
    )
  ).rejects.toThrow('HEAD failed (403)');
});

it('retries transient transport failures within a bound without exposing exception text', async () => {
  let attempts = 0;
  const store = remoteArtifactStore({
    accountId: 'a'.repeat(32),
    bucket: 'test-runtime',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'secret',
    request: async () => {
      attempts += 1;
      throw new Error('Authorization: secret');
    },
  });
  await expect(store.getBytes(`runtime-artifacts/v1/objects/${'b'.repeat(64)}`)).rejects.toThrow(
    'runtime store GET request failed'
  );
  expect(attempts).toBe(3);
});
