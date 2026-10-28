import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { createSseDecoder, isolatedKiloEnvironment, openKiloSse } from '../e2e/local-kilo.js';

test('isolates home, configuration, and credentials from the parent process', () => {
  const env = isolatedKiloEnvironment({
    home: '/test/home',
    token: 'local-token',
    password: 'local-password',
    web: 'http://localhost:6500',
    worker: 'http://localhost:12294',
    gateway: 'http://localhost:6510',
    parent: {
      HOME: '/real/home',
      PATH: '/test/bin',
      KILO_API_KEY: 'real-token',
      KILO_AUTH_CONTENT: 'real-auth',
      KILO_CONFIG: '/real/config',
      OPENAI_API_KEY: 'real-provider-token',
      CLOUD_AGENT_NEXT_BASE_URL: 'https://production.example',
    },
  });
  assert.equal(env.HOME, '/test/home');
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    assert(env[name]?.startsWith('/test/home/'));
  }
  assert.equal(env.PATH, '/test/bin');
  assert.equal(env.KILO_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.KILO_CONFIG, undefined);
  assert.deepEqual(JSON.parse(env.KILO_AUTH_CONTENT ?? ''), {
    kilo: { type: 'api', key: 'local-token' },
  });
  assert.equal(env.CLOUD_AGENT_NEXT_BASE_URL, 'http://localhost:12294');
  assert.equal(env.KILO_WEB_APP_URL, 'http://localhost:6500');
  assert.equal(env.KILO_DISABLE_MODELS_FETCH, '1');
  assert.equal(env.KILO_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.KILO_DISABLE_EXTERNAL_SKILLS, '1');
  assert.equal(env.KILO_AI_GATEWAY_URL, 'http://localhost:6510/api/v1');
});

test('decodes split CRLF, multiline frames, and comments without losing the fence', () => {
  const decode = createSseDecoder();
  assert.deepEqual(decode(': heartbeat\r'), []);
  assert.deepEqual(decode('\n\r\ndata: {"type":"kilo.native.'), []);
  assert.deepEqual(decode('fence",\r\ndata: "properties":{"cursor":12}}\r\n\r'), []);
  assert.deepEqual(decode('\n'), [{ type: 'kilo.native.fence', properties: { cursor: 12 } }]);
  assert.deepEqual(decode('data: {"type":"server.connected"}\n\n'), [
    { type: 'server.connected', properties: {} },
  ]);
});

test('rejects malformed event properties and bounds incomplete frames', () => {
  assert.throws(() => createSseDecoder()('data: {"type":"x","properties":[]}\n\n'), /properties/);
  assert.throws(() => createSseDecoder()('x'.repeat(1024 * 1024 + 1)), /bound/);
});

test('observes live SSE frames and closes the upstream request', async () => {
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"server.connected"}\n\n');
    const timer = setTimeout(
      () => response.write('data: {"type":"message.updated","properties":{"id":"reply"}}\n\n'),
      20
    );
    request.on('close', () => {
      clearTimeout(timer);
      closed.resolve();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const stream = await openKiloSse(`http://127.0.0.1:${address.port}/event`, {});
    try {
      await stream.wait(event => event.type === 'server.connected', 'connected', 0, 1000);
      assert.equal(
        (await stream.wait(event => event.type === 'message.updated', 'live reply', 0, 1000))
          .properties.id,
        'reply'
      );
    } finally {
      await stream.close();
    }
    const timer = setTimeout(
      () => closed.reject(new Error('Upstream request did not close')),
      1000
    );
    try {
      await closed.promise;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
