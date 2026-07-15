import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';

import { probeDockerApi } from './docker-api-probe';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('does not identify an arbitrary TCP listener as the Docker API proxy', async () => {
  const server = http.createServer((_request, response) => {
    response.end('not docker');
  });
  const port = await listen(server);

  try {
    assert.equal(await probeDockerApi(port), false);
  } finally {
    await close(server);
  }
});

test('identifies a ready Docker API listener by its ping response', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/_ping');
    response.setHeader('Api-Version', '1.48');
    response.end('OK');
  });
  const port = await listen(server);

  try {
    assert.equal(await probeDockerApi(port), true);
  } finally {
    await close(server);
  }
});
