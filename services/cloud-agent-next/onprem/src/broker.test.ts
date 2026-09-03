import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { serve } from 'bun';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startOnPremBroker,
  type BrokerAllocation,
  type OnPremBroker,
  type OnPremBrokerOptions,
} from './broker.js';

let directory: string;
let ca: string;
let broker: OnPremBroker;
let upstream: ReturnType<typeof serve>;
let upstreamOrigin: string;
let allocation: BrokerAllocation | null;
let denied = false;
let expiresAt: number;
let cancelled = Promise.withResolvers<void>();
const observed: { url: string; headers: Headers; body: string }[] = [];
const redemptions: Parameters<OnPremBrokerOptions['resolveCredential']>[1][] = [];
const peers: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kilo-broker-test-'));
  const certFile = join(directory, 'tls.crt');
  const keyFile = join(directory, 'tls.key');
  const configFile = join(directory, 'openssl.cnf');
  await writeFile(
    configFile,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1,DNS:github.com,DNS:api.github.com\nbasicConstraints=critical,CA:TRUE\n'
  );
  const openssl = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      configFile,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  if (openssl.exitCode !== 0) throw new Error('Local TLS fixture generation failed');
  ca = await readFile(certFile, 'utf8');
  upstream = serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      observed.push({ url: request.url, headers: request.headers, body: await request.text() });
      if (new URL(request.url).pathname === '/redirect') {
        return Response.redirect(`${upstreamOrigin}/redirect-target`, 302);
      }
      if (new URL(request.url).pathname === '/stream') {
        const cancellation = cancelled;
        request.signal.addEventListener('abort', () => cancellation.resolve(), { once: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first chunk'));
            },
            cancel() {
              cancellation.resolve();
            },
          })
        );
      }
      return new Response('upstream body', {
        headers: {
          authorization: 'Bearer fixture-native',
          'set-cookie': 'fixture=value',
          'x-kilocode-organizationid': 'trusted-org',
          connection: 'x-internal-response',
          'x-internal-response': 'private',
        },
      });
    },
  });
  upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
  broker = await startOnPremBroker({
    port: 0,
    hostname: '127.0.0.1',
    tls: { certFile, keyFile },
    brokerOrigin: 'https://localhost',
    upstreams: {
      backendBaseUrl: upstreamOrigin,
      providerBaseUrl: upstreamOrigin,
      sessionIngestBaseUrl: upstreamOrigin,
    },
    localFixtureUpstreams: { 'github.com': upstreamOrigin, 'api.github.com': upstreamOrigin },
    async resolveAllocation(peerIp) {
      peers.push(peerIp);
      return allocation;
    },
    async resolveCredential(_allocation, request) {
      redemptions.push(request);
      return denied
        ? null
        : {
            headers: {
              authorization: 'Bearer fixture-native',
              host: new URL(request.url).host,
              'x-kilocode-organizationid': 'trusted-org',
            },
            expiresAt,
          };
    },
  });
});

beforeEach(() => {
  allocation = {
    providerRef: 'fixture-allocation',
    podUid: 'fixture-pod',
    hardStopAt: Date.now() + 60_000,
  };
  expiresAt = Date.now() + 60_000;
  denied = false;
  observed.length = 0;
  redemptions.length = 0;
  peers.length = 0;
  cancelled = Promise.withResolvers<void>();
});

afterAll(async () => {
  await broker?.stop();
  await upstream?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('host')) headers.set('host', 'localhost');
  return fetch(`https://127.0.0.1:${broker.port}${path}`, {
    ...options,
    headers,
    tls: { ca, rejectUnauthorized: true },
    redirect: 'manual',
  });
}

test('streams a request and injects credentials only upstream', async () => {
  const response = await request('/_kilo/provider/api/chat?model=a%2Fb&model=c', {
    method: 'POST',
    headers: {
      authorization: 'Bearer task-alias',
      cookie: 'task=value',
      'x-forwarded-for': '192.0.2.1',
      'x-kilocode-organizationid': 'task-org',
      connection: 'x-private-hop',
      'x-private-hop': 'private',
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('request chunk'));
        controller.close();
      },
    }),
  });
  expect(await response.text()).toBe('upstream body');
  expect(redemptions).toEqual([
    {
      url: `${upstreamOrigin}/api/chat?model=a%2Fb&model=c`,
      method: 'POST',
      authorization: 'Bearer task-alias',
    },
  ]);
  expect(peers).toEqual(['127.0.0.1']);
  expect(observed[0]?.body).toBe('request chunk');
  expect(observed[0]?.headers.get('authorization')).toBe('Bearer fixture-native');
  expect(observed[0]?.headers.get('x-kilocode-organizationid')).toBe('trusted-org');
  for (const name of ['cookie', 'x-forwarded-for', 'x-private-hop']) {
    expect(observed[0]?.headers.has(name)).toBe(false);
  }
  for (const name of [
    'authorization',
    'set-cookie',
    'x-kilocode-organizationid',
    'x-internal-response',
  ]) {
    expect(response.headers.has(name)).toBe(false);
  }
});

test('keeps all Kilo paths and fixed GitHub logical origins', async () => {
  for (const prefix of ['backend', 'provider', 'ingest']) {
    const response = await request(`/_kilo/${prefix}/original/path?x=%2F%23`);
    expect(response.status).toBe(200);
    await response.text();
    expect(redemptions.at(-1)?.url).toBe(`${upstreamOrigin}/original/path?x=%2F%23`);
  }
  for (const host of ['github.com', 'api.github.com']) {
    const response = await request('/owner/repo.git/info/refs?service=git-upload-pack', {
      headers: { host },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(redemptions.at(-1)?.url).toBe(
      `https://${host}/owner/repo.git/info/refs?service=git-upload-pack`
    );
  }
});

test('denies unknown peers and rejected credentials without anonymous fallback', async () => {
  const known = allocation;
  allocation = null;
  expect(
    (await request('/_kilo/backend/private', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status
  ).toBe(403);
  expect(redemptions).toHaveLength(0);
  allocation = known;
  denied = true;
  expect(
    (
      await request('/owner/repo.git/info/refs', {
        headers: { host: 'github.com', authorization: 'Bearer rejected' },
      })
    ).status
  ).toBe(403);
  expect(observed).toHaveLength(0);
});

test('health is public but does not authorize other requests', async () => {
  allocation = null;
  for (const path of ['/health', '/healthz']) expect((await request(path)).status).toBe(200);
  expect(peers).toHaveLength(0);
  expect((await request('/_kilo/provider/private')).status).toBe(403);
  expect(observed).toHaveLength(0);
});

test('rejects unapproved hosts and canonicalization escapes', async () => {
  for (const path of [
    '/_kilo/provider//elsewhere.invalid/private',
    '/_kilo/provider/%2f%2felsewhere.invalid/private',
    '/_kilo/provider/%252e%252e/private',
    '/_kilo/provider/../../../private',
    '/_kilo/provider/%5cprivate',
  ]) {
    const response = await request(path);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  }
  expect((await request('/private', { headers: { host: 'elsewhere.invalid' } })).status).toBe(403);
  expect(observed).toHaveLength(0);
  expect(redemptions).toHaveLength(0);
});

test('does not follow or expose an upstream redirect', async () => {
  const response = await request('/_kilo/backend/redirect');
  expect(response.status).toBe(502);
  expect(response.headers.has('location')).toBe(false);
  expect(await response.text()).toBe('Broker request denied');
  expect(observed).toHaveLength(1);
});

test.each(['grant', 'allocation', 'revoke', 'disconnect'])(
  'cancels a streaming response on %s',
  async reason => {
    if (reason === 'grant') expiresAt = Date.now() + 200;
    if (reason === 'allocation' && allocation) allocation.hardStopAt = Date.now() + 200;
    const controller = new AbortController();
    const response = await request('/_kilo/provider/stream', { signal: controller.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first chunk');
    const interrupted = reader.read().then(
      result => result.done,
      () => true
    );
    if (reason === 'revoke') broker.revokeAllocation('fixture-allocation');
    if (reason === 'disconnect') controller.abort();
    expect(await interrupted).toBe(true);
    await cancelled.promise;
  },
  3000
);
