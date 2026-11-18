import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createKiloClient } from '@kilocode/sdk';
import { createKiloClient as createKiloV2Client } from '@kilocode/sdk/v2';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import {
  createKiloServerCredential,
  fetchKiloServer,
  kiloClientConfig,
  type KiloServer,
} from './kilo-server-auth.js';

/** Every request the fake Kilo saw: path and `Authorization` header. */
const seen: Array<{ path: string; authorization: string | null }> = [];
let fake: Bun.Server<undefined>;

beforeAll(() => {
  fake = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, authorization: request.headers.get('Authorization') });
      if (url.pathname === '/global/event') {
        return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.pathname === '/global/health') {
        return Response.json({ healthy: true, version: 'test' });
      }
      return Response.json([]);
    },
  });
});

afterAll(async () => {
  await fake.stop(true);
});

beforeEach(() => {
  seen.length = 0;
});

function server(): KiloServer {
  return { url: fake.url.toString(), authorization: createKiloServerCredential().authorization };
}

describe('kilo server credential', () => {
  it('gives Kilo the password and username that the header encodes', () => {
    const credential = createKiloServerCredential();
    const encoded = credential.authorization.replace(/^Basic /, '');
    expect(Buffer.from(encoded, 'base64').toString()).toBe(
      `${credential.env.KILO_SERVER_USERNAME}:${credential.env.KILO_SERVER_PASSWORD}`
    );
    expect(credential.env.KILO_SERVER_USERNAME).toBe('kilo');
    expect(credential.env.KILO_SERVER_PASSWORD?.length).toBeGreaterThanOrEqual(43);
  });

  it('creates a different password for each server', () => {
    expect(createKiloServerCredential().env.KILO_SERVER_PASSWORD).not.toBe(
      createKiloServerCredential().env.KILO_SERVER_PASSWORD
    );
  });
});

describe('kilo server connections', () => {
  it('sends the credential from every SDK client built with kiloClientConfig', async () => {
    const target = server();
    await createKiloClient(kiloClientConfig(target, '/workspace')).session.list();
    await createKiloV2Client(kiloClientConfig(target)).global.health();
    const events = createKiloEventClient(kiloClientConfig(target, '/workspace'));
    await events.global.health();
    const feed = await events.global.event({ sseMaxRetryAttempts: 1 });
    for await (const event of feed.stream) {
      expect(event).toMatchObject({ type: 'server.connected' });
      break;
    }

    expect(seen.map(request => request.path)).toEqual([
      '/session',
      '/global/health',
      '/global/health',
      '/global/event',
    ]);
    for (const request of seen) expect(request.authorization).toBe(target.authorization ?? null);
  });

  it('adds the credential to a raw request and keeps the caller headers', async () => {
    const target = server();
    const url = new URL('/pty', target.url);
    url.searchParams.set('directory', '/workspace');
    const response = await fetchKiloServer(target, url, {
      headers: { 'x-test': '1', Authorization: 'Basic wrong' },
    });

    expect(response.ok).toBe(true);
    expect(seen).toEqual([{ path: '/pty', authorization: target.authorization ?? null }]);
  });

  it('sends no credential for a server started without a password', async () => {
    await fetchKiloServer({ url: fake.url.toString() }, '/pty');
    await createKiloV2Client(kiloClientConfig({ url: fake.url.toString() })).global.health();

    expect(seen).toEqual([
      { path: '/pty', authorization: null },
      { path: '/global/health', authorization: null },
    ]);
  });
});
