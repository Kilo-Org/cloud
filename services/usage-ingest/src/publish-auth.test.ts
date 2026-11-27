import { STS_USAGE_PUBLISH } from '@kilocode/sts-contracts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaRecord } from './exa-usage.test-fixture';
import { publishAuthMode } from './publish-auth';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import type { Env } from './publish-usage';
import { RESOURCE_METADATA_PATH, USAGE_INGEST_RESOURCE_ORIGINS } from './sts';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-canary.test-fixture';
import { usage } from './usage.test-fixture';

const STS_URL = 'https://sts.kiloapps.io';
const SECRET = 'synthetic-publish-secret';

let signer: TestSigner;

beforeAll(async () => {
  signer = await testSigner();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetInternalAuthObservation();
});

/** Serves the stand-in key set at the production issuer; `keySet: false` answers it with 500. */
function stubKeySet({ keySet = true }: { keySet?: boolean } = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (keySet && url === `${STS_URL}/.well-known/jwks.json`) return Response.json(signer.jwks);
    return new Response('unavailable', { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function setup(overrides: Partial<Env> = {}) {
  const accepted = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  const send = vi.fn<Env['USAGE_INGEST_QUEUE']['send']>().mockResolvedValue(accepted);
  const tagged = vi.fn<Env['USAGE_INGEST_ENKRYPT_QUEUE']['send']>().mockResolvedValue(accepted);
  const env: Env = {
    USAGE_INGEST_PUBLISH_SECRET: SECRET,
    USAGE_INGEST_QUEUE: { send, sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_INGEST_DLQ: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_INGEST_ENKRYPT_QUEUE: { send: tagged, sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_INGEST_ENKRYPT_DLQ: { send: vi.fn(), sendBatch: vi.fn(), metrics: vi.fn() },
    USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED: 'true',
    STS_URL,
    STS_ENVIRONMENT: 'production',
    ...overrides,
  };
  return { send, tagged, env };
}

function publish(
  authorization: string | null,
  path = '/usage',
  body: BodyInit = JSON.stringify(usage),
  origin = 'https://usage-ingest.test'
) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    body,
    headers: authorization === null ? {} : { Authorization: authorization },
    duplex: 'half',
  } as RequestInit);
}

/** A body that records whether anything read it; `highWaterMark: 0` stops any eager pull. */
function watchedBody(text: string) {
  const watch = { read: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        watch.read = true;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { body, watch };
}

function publishClaims(workload: string, overrides: Record<string, unknown>) {
  return {
    ...serviceClaims({
      issuer: STS_URL,
      workload,
      audience: STS_USAGE_PUBLISH.audience,
      scope: STS_USAGE_PUBLISH.scope,
    }),
    ...overrides,
  };
}

async function stsBearer(
  overrides: Record<string, unknown> = {},
  { by = signer, workload = 'ai-gateway' }: { by?: TestSigner; workload?: string } = {}
) {
  return `Bearer ${await signToken(by, publishClaims(workload, overrides))}`;
}

const CHALLENGE_METADATA = `resource_metadata="${USAGE_INGEST_RESOURCE_ORIGINS.production}${RESOURCE_METADATA_PATH}"`;

function enqueueStartLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter(line => line.event === 'usage_ingest_enqueue_start');
}

async function expectLegacyRefusal(response: Response, status: 401 | 503) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    error: status === 401 ? 'Unauthorized' : 'Service unavailable',
  });
  expect(response.headers.get('www-authenticate')).toBeNull();
}

describe('publishAuthMode', () => {
  it('defaults to legacy and refuses unknown values', () => {
    expect(publishAuthMode(undefined)).toBe('legacy');
    expect(publishAuthMode('legacy')).toBe('legacy');
    expect(publishAuthMode('dual')).toBe('dual');
    expect(publishAuthMode('sts')).toBe('sts');
    for (const value of ['', 'Dual', 'STS', 'true', 'off']) {
      expect(publishAuthMode(value)).toBeNull();
    }
  });
});

describe('legacy mode (default)', () => {
  it('keeps the secret answers and never reaches STS, even for a valid STS token', async () => {
    const fetch = stubKeySet();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const mode of [undefined, 'legacy']) {
      const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: mode });
      expect((await worker.fetch(publish(`Bearer ${SECRET}`), env)).status).toBe(202);
      expect(send).toHaveBeenCalledTimes(1);
      await expectLegacyRefusal(await worker.fetch(publish(await stsBearer()), env), 401);
      await expectLegacyRefusal(await worker.fetch(publish('Bearer wrong'), env), 401);
      await expectLegacyRefusal(await worker.fetch(publish(null), env), 401);
      const unset = setup({
        USAGE_INGEST_PUBLISH_AUTH: mode,
        USAGE_INGEST_PUBLISH_SECRET: undefined,
      });
      await expectLegacyRefusal(await worker.fetch(publish(await stsBearer()), unset.env), 503);
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(fetch).not.toHaveBeenCalled();
    // The accepted line keeps its shape: no credential fields under legacy.
    for (const line of enqueueStartLines(info)) {
      expect(line).not.toHaveProperty('auth');
      expect(line).not.toHaveProperty('auth_caller');
    }
  });
});

describe('an unknown mode', () => {
  it('refuses every publish with 503, the right secret included', async () => {
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'Dual' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expectLegacyRefusal(await worker.fetch(publish(`Bearer ${SECRET}`), env), 503);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('dual mode', () => {
  it('reports each accepted request to the item-9 counter (design 9.4)', async () => {
    stubKeySet();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });

    expect((await worker.fetch(publish(`Bearer ${SECRET}`), env)).status).toBe(202);
    expect((await worker.fetch(publish(await stsBearer()), env)).status).toBe(202);

    const lines = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(line => line.event === 'kilo_internal_auth');
    expect(lines).toEqual([
      expect.objectContaining({
        receiver: 'usage-ingest',
        route: 'usage_publish',
        auth: 'legacy_shared_secret',
        caller: 'unknown',
        count: 1,
      }),
      expect.objectContaining({
        receiver: 'usage-ingest',
        route: 'usage_publish',
        auth: 'sts',
        caller: 'ai-gateway',
        count: 1,
      }),
    ]);
  });

  it('accepts the secret and a usage-ingest:usage.publish STS token, and labels each', async () => {
    stubKeySet();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    expect((await worker.fetch(publish(`Bearer ${SECRET}`), env)).status).toBe(202);
    expect((await worker.fetch(publish(await stsBearer()), env)).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(2);
    expect(enqueueStartLines(info)).toEqual([
      expect.objectContaining({ auth: 'legacy' }),
      expect.objectContaining({ auth: 'sts', auth_caller: 'ai-gateway' }),
    ]);
  });

  it('keeps the secret answers for a credential that is not a JWS', async () => {
    const fetch = stubKeySet();
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    await expectLegacyRefusal(await worker.fetch(publish('Bearer wrong'), env), 401);
    await expectLegacyRefusal(await worker.fetch(publish(null), env), 401);
    const unset = setup({
      USAGE_INGEST_PUBLISH_AUTH: 'dual',
      USAGE_INGEST_PUBLISH_SECRET: undefined,
    });
    await expectLegacyRefusal(await worker.fetch(publish('Bearer wrong'), unset.env), 503);
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a bad STS token per design section 7, never falling back to the secret', async () => {
    stubKeySet();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    const refuse = async (authorization: string) => worker.fetch(publish(authorization), env);

    const canary = await refuse(await stsBearer({ scope: 'usage-ingest:sts.canary' }));
    expect(canary.status).toBe(403);
    expect(await canary.json()).toMatchObject({ error: 'insufficient_scope' });

    const wrongAudience = await refuse(
      `Bearer ${await signToken(
        signer,
        serviceClaims({
          issuer: STS_URL,
          workload: 'usage-ingest',
          audience: 'web',
          scope: 'web:sts.canary',
        })
      )}`
    );
    expect(wrongAudience.status).toBe(403);

    const forged = await stsBearer({}, { by: await testSigner(signer.kid) });
    expect((await refuse(forged)).status).toBe(401);
    const past = Math.floor(Date.now() / 1000) - 3_600;
    expect((await refuse(await stsBearer({ iat: past, exp: past + 300 }))).status).toBe(401);
    expect((await refuse(await stsBearer({ env: 'staging' }))).status).toBe(401);
    const otherIssuer = await stsBearer({ iss: 'https://sts-staging.kiloapps.io' });
    expect((await refuse(otherIssuer)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('usage_ingest_publish_auth_refused');
    // Every refused token starts with its base64url JOSE header (`{"` encodes as `eyJ`).
    expect(logged).not.toContain('eyJ');
  });

  it('answers 503 when STS verification cannot run, without trying the secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unconfigured = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual', STS_URL: undefined });
    stubKeySet();
    expect((await worker.fetch(publish(await stsBearer()), unconfigured.env)).status).toBe(503);

    // A fresh issuer configuration (staging) builds a fresh verifier with an empty key-set cache.
    stubKeySet({ keySet: false });
    const staging = setup({
      USAGE_INGEST_PUBLISH_AUTH: 'dual',
      STS_URL: 'https://sts-staging.kiloapps.io',
      STS_ENVIRONMENT: 'staging',
    });
    const unavailable = await worker.fetch(
      publish(await stsBearer({ iss: 'https://sts-staging.kiloapps.io', env: 'staging' })),
      staging.env
    );
    expect(unavailable.status).toBe(503);
    expect(staging.send).not.toHaveBeenCalled();
    expect(unconfigured.send).not.toHaveBeenCalled();
  });

  it('applies to the Enkrypt and Exa paths', async () => {
    stubKeySet();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { tagged, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    for (const [path, body, workload] of [
      ['/enkrypt-usage', enkryptRecord, 'ai-gateway'],
      ['/exa-usage', exaRecord, 'web'],
    ] as const) {
      const json = JSON.stringify(body);
      const bearer = await stsBearer({}, { workload });
      expect((await worker.fetch(publish(bearer, path, json), env)).status).toBe(202);
      expect((await worker.fetch(publish(`Bearer ${SECRET}`, path, json), env)).status).toBe(202);
      await expectLegacyRefusal(await worker.fetch(publish('Bearer wrong', path, json), env), 401);
    }
    expect(tagged).toHaveBeenCalledTimes(4);
  });

  it('pins each path to its publisher, refusing other workloads before the body', async () => {
    stubKeySet();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, tagged, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    for (const [path, payload, workload] of [
      ['/usage', usage, 'web'],
      ['/usage', usage, 'usage-ingest'],
      ['/enkrypt-usage', enkryptRecord, 'web'],
      ['/exa-usage', exaRecord, 'ai-gateway'],
    ] as const) {
      const { body, watch } = watchedBody(JSON.stringify(payload));
      const bearer = await stsBearer({}, { workload });
      const refused = await worker.fetch(publish(bearer, path, body), env);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'insufficient_scope' });
      expect(watch.read).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(tagged).not.toHaveBeenCalled();
    const reasons = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(line => line.event === 'usage_ingest_publish_auth_refused')
      .map(line => line.reason);
    expect(reasons).toEqual(['workload', 'workload', 'workload', 'workload']);

    // Control: the pinned publisher's token reads the same kind of body and enqueues it.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { body, watch } = watchedBody(JSON.stringify(usage));
    const accepted = await worker.fetch(publish(await stsBearer(), '/usage', body), env);
    expect(accepted.status).toBe(202);
    expect(watch.read).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('names its fixed origin in challenges and keeps one verifier for any host', async () => {
    const fetch = stubKeySet();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    for (const origin of ['https://a.test', 'https://b.test', 'https://attacker.example']) {
      const accepted = await worker.fetch(
        publish(await stsBearer(), '/usage', JSON.stringify(usage), origin),
        env
      );
      expect(accepted.status).toBe(202);
      const forged = await stsBearer({}, { by: await testSigner(signer.kid) });
      const refused = await worker.fetch(
        publish(forged, '/usage', JSON.stringify(usage), origin),
        env
      );
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toContain(CHALLENGE_METADATA);
      expect(refused.headers.get('www-authenticate')).not.toContain(origin);
    }
    expect(send).toHaveBeenCalledTimes(3);
    // At most one key-set fetch: an earlier test may already have warmed the one verifier.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('sts mode', () => {
  it('accepts only an STS token; the secret gets the design section 7 refusal', async () => {
    stubKeySet();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'sts' });
    expect((await worker.fetch(publish(await stsBearer()), env)).status).toBe(202);
    const secret = await worker.fetch(publish(`Bearer ${SECRET}`), env);
    expect(secret.status).toBe(401);
    expect(secret.headers.get('www-authenticate')).toContain(CHALLENGE_METADATA);
    const missing = await worker.fetch(publish(null), env);
    expect(missing.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('protected-resource metadata', () => {
  const STAGING_STS_URL = 'https://sts-staging.kiloapps.io';

  function metadataRequest(
    method = 'GET',
    path = RESOURCE_METADATA_PATH,
    origin = 'https://a.test'
  ) {
    return new Request(`${origin}${path}`, { method });
  }

  async function expectOrdinaryNotFound(response: Response) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  }

  it('stays an ordinary 404 with no I/O by default, unknown mode or invalid environment', async () => {
    const fetch = stubKeySet();
    for (const overrides of [
      {},
      { USAGE_INGEST_PUBLISH_AUTH: 'legacy' },
      { USAGE_INGEST_PUBLISH_AUTH: 'Dual' },
      // `STS_ENVIRONMENT` disagrees with the issuer `STS_URL` names.
      { USAGE_INGEST_PUBLISH_AUTH: 'dual', STS_ENVIRONMENT: 'staging' },
      { USAGE_INGEST_PUBLISH_AUTH: 'sts', STS_URL: undefined },
    ]) {
      const { send, env } = setup(overrides);
      await expectOrdinaryNotFound(await worker.fetch(metadataRequest(), env));
      await expectOrdinaryNotFound(await worker.fetch(metadataRequest('POST'), env));
      expect(send).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves the fixed origin, issuer and publish scope under dual or sts, whatever the host', async () => {
    const fetch = stubKeySet();
    const cases = [
      [{ USAGE_INGEST_PUBLISH_AUTH: 'dual' }, 'production', STS_URL],
      [
        { USAGE_INGEST_PUBLISH_AUTH: 'sts', STS_URL: STAGING_STS_URL, STS_ENVIRONMENT: 'staging' },
        'staging',
        STAGING_STS_URL,
      ],
    ] as const;
    for (const [overrides, environment, issuer] of cases) {
      const { env } = setup(overrides);
      for (const origin of ['https://a.test', 'https://attacker.example']) {
        const response = await worker.fetch(
          metadataRequest('GET', RESOURCE_METADATA_PATH, origin),
          env
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          resource: USAGE_INGEST_RESOURCE_ORIGINS[environment],
          authorization_servers: [issuer],
          scopes_supported: ['usage-ingest:usage.publish'],
          bearer_methods_supported: ['header'],
          resource_name: 'Kilo usage ingest',
        });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serves only GET on the exact path', async () => {
    const { env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    const post = await worker.fetch(metadataRequest('POST'), env);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    for (const path of [
      `${RESOURCE_METADATA_PATH}/`,
      `${RESOURCE_METADATA_PATH}/usage`,
      '/.well-known/oauth-authorization-server',
    ]) {
      await expectOrdinaryNotFound(await worker.fetch(metadataRequest('GET', path), env));
    }
  });

  it('serves the route a publish challenge names', async () => {
    stubKeySet();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = setup({ USAGE_INGEST_PUBLISH_AUTH: 'dual' });
    const forged = await stsBearer({}, { by: await testSigner(signer.kid) });
    const challenge = (await worker.fetch(publish(forged), env)).headers.get('www-authenticate');
    const named = /resource_metadata="([^"]+)"/.exec(challenge ?? '')?.[1];
    expect(named).toBe(`${USAGE_INGEST_RESOURCE_ORIGINS.production}${RESOURCE_METADATA_PATH}`);
    const served = await worker.fetch(new Request(named ?? 'https://missing.test/'), env);
    expect(served.status).toBe(200);
  });
});
