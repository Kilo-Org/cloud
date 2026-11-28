import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { GITHUB_RELAY_URL } from '../../src/config';
import {
  GithubUnavailableError,
  RELAY_AUTHORIZATION_HEADER,
  createGithubClient,
  type GithubFetch,
} from '../../src/github';

/** The reads through the GitHub relay (services/github-relay); the mint stays on api.github.com. */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = Date.parse('2026-11-27T18:00:00Z');

let pem: string;
beforeAll(() => {
  pem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
});

type Call = { url: string; method: string; headers: Headers };

/** api.github.com mints; `read` answers every other URL. */
function github(read: (url: string) => Promise<Response>): { fetcher: GithubFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: GithubFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
    if (url.endsWith('/access_tokens')) {
      return Response.json(
        { token: 'ghs_installation', expires_at: new Date(NOW + 3_600_000).toISOString() },
        { status: 201 }
      );
    }
    return await read(url);
  };
  return { fetcher, calls };
}

function client(
  fetcher: GithubFetch,
  token: () => Promise<string> = async () => 'sts-relay-token'
) {
  return createGithubClient(
    {
      appId: '5952011',
      installationId: '186479258',
      apiUrl: 'https://api.github.com',
      privateKey: async () => pem,
      relay: { url: GITHUB_RELAY_URL, token },
    },
    fetcher,
    () => NOW
  );
}

async function failure(promise: Promise<unknown>): Promise<GithubUnavailableError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  if (!(error instanceof GithubUnavailableError))
    throw new Error(`expected unavailable, got ${String(error)}`);
  return error;
}

describe('reads through the GitHub relay', () => {
  it('sends reads to the relay with both tokens, and the mint straight to GitHub without the relay token', async () => {
    const { fetcher, calls } = github(async () => Response.json({ status: 'ahead' }));
    expect(await client(fetcher).compare(SHA_A, SHA_B)).toBe('ahead');
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['POST', 'https://api.github.com/app/installations/186479258/access_tokens'],
      [
        'GET',
        `https://github-relay.kiloapps.io/migration-proxy/repos/Kilo-Org/cloud/compare/${SHA_A}...${SHA_B}?per_page=1`,
      ],
    ]);
    expect(calls[0].headers.get(RELAY_AUTHORIZATION_HEADER)).toBeNull();
    expect(calls[1].headers.get(RELAY_AUTHORIZATION_HEADER)).toBe('Bearer sts-relay-token');
    expect(calls[1].headers.get('Authorization')).toBe('token ghs_installation');
  });

  it('counts an unreachable relay as GitHub unavailable, retried on the usual schedule', async () => {
    const { fetcher } = github(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const error = await failure(client(fetcher).tree(SHA_A));
    expect(error.message).toBe('github unavailable: network');
    expect(error.retryAt).toBeNull();
  });

  it.each([500, 502, 504])('counts a relay %i as GitHub unavailable', async status => {
    const { fetcher } = github(async () => new Response('', { status }));
    const error = await failure(client(fetcher).blob(SHA_A));
    expect(error.message).toBe(`github unavailable: GET ${status}`);
    expect(error.retryAt).toBeNull();
  });

  it('honours the Retry-After of a relay 503', async () => {
    const { fetcher } = github(
      async () => new Response('', { status: 503, headers: { 'retry-after': '30' } })
    );
    const error = await failure(client(fetcher).tree(SHA_A));
    expect(error.retryAt).toBe(NOW + 30_000);
  });

  it('counts a failed STS mint for the relay as GitHub unavailable, without calling the relay', async () => {
    const { fetcher, calls } = github(async () => Response.json({ status: 'ahead' }));
    const error = await failure(
      client(fetcher, async () => {
        throw new Error('sts down');
      }).compare(SHA_A, SHA_B)
    );
    expect(error.message).toBe('github unavailable: relay token unavailable');
    expect(calls.filter(call => call.url.startsWith(GITHUB_RELAY_URL))).toEqual([]);
  });

  it('keeps the installation token on a relay 401, and mints a new one on a GitHub 401', async () => {
    const challenge =
      'Bearer error="invalid_token", resource_metadata="https://github-relay.kiloapps.io/.well-known/oauth-protected-resource"';
    const relayed = github(async () =>
      Response.json(
        { error: 'invalid_token' },
        { status: 401, headers: { 'www-authenticate': challenge } }
      )
    );
    const throughRelay = client(relayed.fetcher);
    expect((await failure(throughRelay.tree(SHA_A))).message).toBe('github unavailable: relay 401');
    await failure(throughRelay.tree(SHA_A));
    expect(relayed.calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(1);

    const refused = github(async () =>
      Response.json({ message: 'Bad credentials' }, { status: 401 })
    );
    const fromGithub = client(refused.fetcher);
    expect((await failure(fromGithub.tree(SHA_A))).message).toBe('github unavailable: GET 401');
    await failure(fromGithub.tree(SHA_A));
    expect(refused.calls.filter(call => call.url.endsWith('/access_tokens'))).toHaveLength(2);
  });
});
