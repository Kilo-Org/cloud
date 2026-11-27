import { describe, expect, it } from 'vitest';
import { HyperdriveClient } from '../../src/rotation/hyperdrive';

/** A config origin as the API returns it. */
const RAW = {
  scheme: 'postgres',
  host: 'db.example.test',
  port: 5432,
  database: 'postgres',
  user: 'uts_app_a',
} as const;

const ORIGIN = { ...RAW, otherFields: [] };

function configResponse(user: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({
    success: true,
    result: { id: 'config-1', origin: { ...RAW, ...extra, user } },
  });
}

type Seen = { method: string; url: string; authorization: string | null; body: unknown };

function client(answers: (() => Response | Promise<Response>)[], seen: Seen[]): HyperdriveClient {
  return new HyperdriveClient(
    { baseUrl: 'https://api.example.test', accountId: 'account-1', token: async () => 'token-1' },
    async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: request.method === 'GET' ? null : await request.json(),
      });
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected request');
      return await next();
    }
  );
}

describe('HyperdriveClient', () => {
  it('reads a config origin with the bearer token', async () => {
    const seen: Seen[] = [];
    expect(await client([() => configResponse('uts_app_a')], seen).read('config-1')).toEqual({
      status: 'ok',
      origin: ORIGIN,
    });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: 'https://api.example.test/client/v4/accounts/account-1/hyperdrive/configs/config-1',
        authorization: 'Bearer token-1',
        body: null,
      },
    ]);
  });

  it('switches the login, keeps scheme, host, port and database, and checks it with a GET', async () => {
    const seen: Seen[] = [];
    const result = await client(
      [() => Response.json({ success: true }), () => configResponse('uts_app_b')],
      seen
    ).switchLogin('config-1', ORIGIN, 'uts_app_b', 'password-1');
    expect(result).toEqual({ status: 'switched' });
    expect(seen.map(request => request.method)).toEqual(['PATCH', 'GET']);
    expect(seen[0]?.body).toEqual({
      origin: { ...RAW, user: 'uts_app_b', password: 'password-1' },
    });
  });

  it('refuses a switch when the GET after the PATCH still names the old login', async () => {
    expect(
      await client(
        [() => Response.json({ success: true }), () => configResponse('uts_app_a')],
        []
      ).switchLogin('c', ORIGIN, 'uts_app_b', 'p')
    ).toEqual({ status: 'refused', detail: 'config did not report the new login after the PATCH' });
  });

  it('names origin fields it does not rebuild, and refuses to PATCH such a config', async () => {
    const seen: Seen[] = [];
    const hyperdrive = client(
      [() => configResponse('uts_app_a', { access_client_id: 'client-1' })],
      seen
    );
    const read = await hyperdrive.read('c');
    expect(read).toEqual({
      status: 'ok',
      origin: { ...ORIGIN, otherFields: ['access_client_id'] },
    });
    if (read.status !== 'ok') throw new Error('read failed');
    expect(await hyperdrive.switchLogin('c', read.origin, 'uts_app_b', 'p')).toEqual({
      status: 'refused',
      detail: 'config origin holds fields the switch does not rebuild: access_client_id',
    });
    expect(seen.map(request => request.method)).toEqual(['GET']);
  });

  it('separates retryable from refused failures and keeps no body', async () => {
    const answers = [
      () => new Response('echo password-1', { status: 503 }),
      () => new Response('echo password-1', { status: 403 }),
      () => Response.json({ success: false }),
      () => Promise.reject(new Error('reset')),
    ];
    const hyperdrive = client(answers, []);
    expect(await hyperdrive.read('c')).toEqual({
      status: 'unreachable',
      detail: 'cloudflare GET answered 503',
    });
    expect(await hyperdrive.switchLogin('c', ORIGIN, 'uts_app_b', 'password-1')).toEqual({
      status: 'refused',
      detail: 'cloudflare PATCH answered 403',
    });
    expect(await hyperdrive.read('c')).toEqual({
      status: 'refused',
      detail: 'config response did not match',
    });
    expect(await hyperdrive.read('c')).toEqual({
      status: 'unreachable',
      detail: 'cloudflare request failed',
    });
  });

  it('refuses when the token cannot be read', async () => {
    const hyperdrive = new HyperdriveClient({
      baseUrl: 'https://api.example.test',
      accountId: 'a',
      token: () => Promise.reject(new Error('missing')),
    });
    expect(await hyperdrive.read('c')).toEqual({
      status: 'refused',
      detail: 'switch token unavailable',
    });
  });
});
