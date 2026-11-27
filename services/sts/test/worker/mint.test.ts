import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  STS_BOUNCER_DECIDE,
  STS_BOUNCER_SIGNUP_DECIDE,
  STS_BOUNCER_SIGNUP_HISTORY,
  STS_BOUNCER_USAGE_WRITE,
  STS_DENIED_PROBE,
  STS_DENIED_PROBE_REASON,
  STS_DENIED_PROBE_WORKLOAD,
  STS_ENVIRONMENTS,
  STS_SECURE_PROXY_FORWARD,
  STS_SECURITY_SYNC_DISMISS_FINDING,
  STS_SECURITY_SYNC_MANUAL_SYNC,
  STS_USAGE_PUBLISH,
  STS_USAGE_RECORD,
  STS_O11Y_ALERTING_READ,
  STS_O11Y_ALERTING_WRITE,
  STS_O11Y_API_METRICS_WRITE,
  STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
  isStsDeniedProbe,
  type MintRequest,
  type MintResult,
} from '@kilocode/sts-contracts';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDenialBuffers, recordDenial } from '../../src/audit/denials';
import { SecretsBroker, serveWorkerMint } from '../../src/broker';
import { TOKEN_SIGNER_RETRY_AFTER_SECONDS, TOKEN_SIGNER_SHARDS } from '../../src/constants';
import { getDenialStub, getTokenSignerStub } from '../../src/dos/stubs';
import type { TokenSignerDO } from '../../src/dos/TokenSignerDO';
import { handleRequest, mintResponse } from '../../src/http';
import { loadPolicies } from '../../src/policy/load';
import {
  defaultMintAuthority,
  serveMint,
  type MintAuthority,
  type MintCaller,
} from '../../src/tokens/mint';
import { stubOfflineNetwork } from './manager';
import { resetDenialObject, resetTokenSignerObject } from './reset';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';
import { config, env } from './test-env';

const FLY_ISSUER = 'https://oidc.fly.io/acme';
const FLY_CLAIMS = {
  org_id: '1111',
  org_name: 'acme',
  app_id: '2222',
  app_name: 'fly-minter',
  machine_id: 'machine-1',
};

const VERCEL_ISSUER = 'https://oidc.vercel.com/acme';
/** An exchanged preview function token (https://vercel.com/docs/oidc/reference). */
const VERCEL_CLAIMS = {
  sub: 'owner:acme:project:acme-web:environment:preview',
  owner: 'acme',
  owner_id: 'team_Acme1',
  project: 'acme-web',
  project_id: 'prj_Web1',
  environment: 'preview',
  act: { iat: Math.floor(Date.now() / 1000) - 60, aud: 'https://vercel.com/acme' },
};

const audiences = Array.from({ length: 9 }, (_, index) => `aud-${index + 1}`);
const scopes = Object.fromEntries(
  audiences.map(audience => [audience, { scopes: [`${audience}:read`] }])
);

/** Nine registered audiences; `probe` may mint for the first eight, `fly-minter` for `aud-1`. */
const authority: MintAuthority = {
  scopes,
  policies: loadPolicies(
    {
      'probe.yaml': `
workload: probe
environments: [development]
identity:
  kind: worker-binding
secrets: []
audiences: [${audiences.slice(0, 8).join(', ')}]
scopes: [${audiences
        .slice(0, 8)
        .map(audience => `'${audience}:read'`)
        .join(', ')}]
`,
      'fly-minter.yaml': `
workload: fly-minter
environments: [development]
identity:
  kind: fly-oidc
  org: acme
  orgId: '1111'
  app: fly-minter
  appId: '2222'
secrets: []
audiences: [aud-1]
scopes: ['aud-1:read']
`,
      'fly-prod.yaml': `
workload: fly-prod
environments: [production]
identity:
  kind: fly-oidc
  org: acme
  orgId: '1111'
  app: fly-prod
  appId: '3333'
secrets: []
audiences: [aud-1]
scopes: ['aud-1:read']
`,
      'vercel-web.yaml': `
workload: vercel-web
environments: [development]
identity:
  kind: vercel-oidc
  teamSlug: acme
  teamId: team_Acme1
  projectId: prj_Web1
  projectName: acme-web
  environments: [preview]
secrets: []
audiences: [aud-2]
scopes: ['aud-2:read']
`,
    },
    { scopeRegistry: scopes }
  ),
};

function entries(count: number): MintRequest['tokens'] {
  return audiences.slice(0, count).map(audience => ({ audience, scope: `${audience}:read` }));
}

let pending: Promise<unknown>[] = [];
const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

function mint(caller: string, request: unknown): Promise<MintResult> {
  return serveWorkerMint(env, config, caller, request, waitUntil, authority);
}

beforeEach(async () => {
  pending = [];
  clearDenialBuffers();
  stubOfflineNetwork();
  for (const shard of SHARDS) await resetTokenSignerObject(getTokenSignerStub(env, config, shard));
  await resetDenialObject(getDenialStub(env, config));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

const SHARDS = Array.from({ length: TOKEN_SIGNER_SHARDS }, (_, shard) => shard);

/** The issued rows of every signer shard. */
async function issuedRows(): Promise<Array<{ data: { attributes: Record<string, unknown> } }>> {
  const rows: Array<{ type: string; data: { attributes: Record<string, unknown> } }> = [];
  for (const shard of SHARDS) {
    const events = await runInDurableObject(
      getTokenSignerStub(env, config, shard),
      (_instance, state) =>
        state.storage.sql
          .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
          .toArray()
          .map(
            row =>
              JSON.parse(row.event) as {
                type: string;
                data: { attributes: Record<string, unknown> };
              }
          )
    );
    rows.push(...events);
  }
  return rows.filter(event => event.type === 'ai.kilo.sts.token.issued');
}

/** Writes the open denial windows as audit events and returns them. */
async function flushedDenials(): Promise<
  Array<{ type: string; data: { attributes: Record<string, unknown> } }>
> {
  await Promise.all(pending);
  const stub = getDenialStub(env, config);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE denial_window SET minute = '2020-01-01T00:00'`);
  });
  await runDurableObjectAlarm(stub);
  return await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event))
  );
}

describe('worker-binding mint', () => {
  it('issues a batch of 8 in one signer call with one audit row', async () => {
    const signerCalls = vi.fn();
    const namespace = env.STS_TOKEN_SIGNER_DO;
    const get = namespace.get.bind(namespace);
    const spy = vi.spyOn(namespace, 'get').mockImplementation(id => {
      const real = get(id);
      return {
        id: real.id,
        mint: async (...args: Parameters<TokenSignerDO['mint']>) => {
          signerCalls();
          return await real.mint(...args);
        },
      } as unknown as DurableObjectStub<TokenSignerDO>;
    });

    const result = await mint('probe', { tokens: entries(8) });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.tokens.map(token => token.status)).toEqual(Array(8).fill('issued'));
    expect(result.tokens.map(token => token.audience)).toEqual(audiences.slice(0, 8));
    expect(signerCalls).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const rows = await issuedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].data.attributes).toMatchObject({
      tokenCount: 8,
      audiences: audiences.slice(0, 8),
      jtis: result.tokens.map(token => (token.status === 'issued' ? token.jti : null)),
    });
    expect(pending).toHaveLength(0);
  });

  it('spreads the calls of one workload over every signer shard', async () => {
    const kids = new Set<string>();
    for (let call = 0; call < 40; call += 1) {
      const result = await mint('probe', { tokens: entries(1) });
      if (result.status !== 'ok' || result.tokens[0].status !== 'issued') {
        throw new Error(`expected an issued token, got ${JSON.stringify(result)}`);
      }
      kids.add(String(decodeProtectedHeader(result.tokens[0].token).kid));
    }
    // Each shard signs with its own key; 40 random picks miss a shard with odds near 4 x 0.75^40.
    expect(kids.size).toBe(TOKEN_SIGNER_SHARDS);
  });

  it('refuses 9 tokens and a duplicate audience as invalid requests, signing nothing', async () => {
    expect(await mint('probe', { tokens: entries(9) })).toEqual({ status: 'invalid_request' });
    expect(
      await mint('probe', { tokens: [...entries(2), { audience: 'aud-1', scope: 'aud-1:read' }] })
    ).toEqual({ status: 'invalid_request' });
    expect(await mint('probe', { tokens: [] })).toEqual({ status: 'invalid_request' });
    expect(await issuedRows()).toEqual([]);
  });

  it('refuses an audience or scope over 256 characters as an invalid request and records no denial', async () => {
    const longAudience = 'a'.repeat(257);
    for (const entry of [
      { audience: 'aud-1', scope: `aud-1:${'r'.repeat(251)}` },
      { audience: longAudience, scope: `${longAudience}:read` },
    ]) {
      expect(await mint('probe', { tokens: [entry] })).toEqual({ status: 'invalid_request' });
    }
    expect(pending).toEqual([]);
    expect(await issuedRows()).toEqual([]);
  });

  it('records the valid denials of a hop that also holds one no denial row can hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hop = recordDenial(
      env,
      config,
      {
        kind: 'token',
        channel: 'worker-binding',
        reason: 'unknown_scope',
        actor: 'probe',
        audience: 'aud-1',
        scope: 'aud-1:write',
        claims: {},
      },
      {
        kind: 'token',
        channel: 'worker-binding',
        reason: 'unknown_scope',
        actor: 'x'.repeat(257),
        claims: {},
      }
    );
    if (hop !== null) pending.push(hop);
    const denials = await flushedDenials();
    expect(denials.map(event => event.data.attributes.workload)).toEqual(['probe']);
  });

  it('denies an audience the policy does not grant, audits the denial, and issues the rest', async () => {
    const result = await mint('probe', {
      tokens: [
        { audience: 'aud-1', scope: 'aud-1:read' },
        { audience: 'aud-9', scope: 'aud-9:read' },
      ],
    });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.tokens[0]).toMatchObject({ status: 'issued', audience: 'aud-1' });
    expect(result.tokens[1]).toEqual({
      status: 'denied',
      audience: 'aud-9',
      scope: 'aud-9:read',
      reason: 'audience_not_allowed',
    });
    const denials = await flushedDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      type: 'ai.kilo.sts.token.denied',
      data: {
        outcome: 'denied',
        attributes: {
          channel: 'worker-binding',
          reason: 'audience_not_allowed',
          workload: 'probe',
          audience: 'aud-9',
          scope: 'aud-9:read',
          count: 1,
        },
      },
    });
  });

  it('denies a scope the registry does not list', async () => {
    const result = await mint('probe', { tokens: [{ audience: 'aud-1', scope: 'aud-1:write' }] });
    expect(result).toEqual({
      status: 'ok',
      tokens: [
        { status: 'denied', audience: 'aud-1', scope: 'aud-1:write', reason: 'unknown_scope' },
      ],
    });
    expect(await issuedRows()).toEqual([]);
    const denials = await flushedDenials();
    expect(denials.map(event => event.data.attributes.reason)).toEqual(['unknown_scope']);
  });

  it('denies every token of a caller with no policy, without a signer call', async () => {
    const result = await mint('nobody', { tokens: entries(2) });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.tokens.map(token => token.status === 'denied' && token.reason)).toEqual([
      'unknown_workload',
      'unknown_workload',
    ]);
    expect(await issuedRows()).toEqual([]);
    // Both denials of the call go to the denial object in one hop.
    expect(pending).toHaveLength(1);
  });

  it('refuses a caller whose policy binds another identity kind', async () => {
    expect(await mint('fly-minter', { tokens: entries(1) })).toEqual({
      status: 'identity_rejected',
    });
    const denials = await flushedDenials();
    expect(denials[0].data.attributes).toMatchObject({
      reason: 'identity_rejected',
      workload: 'fly-minter',
    });
    expect(denials[0].data.attributes.audience).toBeUndefined();
  });

  it('answers unavailable and returns no token when the signer call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const namespace = env.STS_TOKEN_SIGNER_DO;
    const get = namespace.get.bind(namespace);
    vi.spyOn(namespace, 'get').mockImplementation(
      id =>
        ({
          id: get(id).id,
          mint: async () => ({ status: 'unavailable' }),
        }) as unknown as DurableObjectStub<TokenSignerDO>
    );
    const result = await mint('probe', { tokens: entries(2) });
    expect(result).toEqual({
      status: 'unavailable',
      retryAfterSeconds: TOKEN_SIGNER_RETRY_AFTER_SECONDS,
    });
    const response = mintResponse(result);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe(String(TOKEN_SIGNER_RETRY_AFTER_SECONDS));
  });

  it('refuses a binding without valid props', async () => {
    const ctx = { props: {}, waitUntil: () => undefined, passThroughOnException: () => undefined };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = new SecretsBroker(ctx as unknown as ExecutionContext, env);
    expect(await broker.mintTokens({ tokens: entries(1) })).toEqual({
      status: 'identity_rejected',
    });
  });
});

describe('HTTP mint', () => {
  // One provider key for the file: STS's isolate keeps the verifier, and its key set, per policy index.
  let provider: TestProvider;
  let vercel: TestProvider;

  beforeAll(async () => {
    provider = await createProvider(FLY_ISSUER, config.issuer);
    vercel = await createProvider(VERCEL_ISSUER, config.issuer);
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', providerFetch([provider, vercel]).fetch);
  });

  async function post(body: string, token?: string): Promise<Response> {
    const ctx = { waitUntil, passThroughOnException: () => undefined, props: {} };
    return await handleRequest(
      new Request(`${config.issuer}/v1/token`, {
        method: 'POST',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        body,
      }),
      env,
      ctx as unknown as ExecutionContext,
      authority
    );
  }

  it('caps the token at the attestation exp', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(provider, FLY_CLAIMS, { issuedAt, expiresAt: issuedAt + 120 });
    const response = await post(JSON.stringify({ tokens: entries(1) }), token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json<MintResult>();
    if (result.status !== 'ok' || result.tokens[0].status !== 'issued') {
      throw new Error(`expected an issued token, got ${JSON.stringify(result)}`);
    }
    expect(result.tokens[0].expiresAt).toBe(issuedAt + 120);
    expect(decodeJwt(result.tokens[0].token)).toMatchObject({
      sub: 'service:fly-minter',
      aud: 'aud-1',
      exp: issuedAt + 120,
    });
    expect((await issuedRows())[0].data.attributes).toMatchObject({
      identity: 'fly',
      attestationCapped: true,
    });
  });

  it('issues a Vercel function the audience and scope its policy grants', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(vercel, VERCEL_CLAIMS, { issuedAt, expiresAt: issuedAt + 3600 });
    const response = await post(
      JSON.stringify({ tokens: [{ audience: 'aud-2', scope: 'aud-2:read' }] }),
      token
    );
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    if (result.status !== 'ok' || result.tokens[0].status !== 'issued') {
      throw new Error(`expected an issued token, got ${JSON.stringify(result)}`);
    }
    expect(decodeJwt(result.tokens[0].token)).toMatchObject({
      sub: 'service:vercel-web',
      aud: 'aud-2',
    });
    expect((await issuedRows())[0].data.attributes).toMatchObject({ identity: 'vercel' });
  });

  it('denies every token as attestation_expiring when the attestation leaves under 60 seconds', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 600;
    const token = await signToken(provider, FLY_CLAIMS, { issuedAt, expiresAt: issuedAt + 630 });
    const response = await post(JSON.stringify({ tokens: entries(1) }), token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      tokens: [
        {
          status: 'denied',
          audience: 'aud-1',
          scope: 'aud-1:read',
          reason: 'attestation_expiring',
        },
      ],
    });
    expect(await issuedRows()).toEqual([]);
    const denials = await flushedDenials();
    expect(denials[0].data.attributes).toMatchObject({
      channel: 'http',
      reason: 'attestation_expiring',
      claims: ['provider=fly'],
    });
  });

  it('refuses a missing bearer, a bad body and an oversized body with the contract statuses', async () => {
    const missing = await post(JSON.stringify({ tokens: entries(1) }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ status: 'identity_rejected' });

    const token = await signToken(provider, FLY_CLAIMS);
    const invalid = await post('not json', token);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ status: 'invalid_request' });

    const oversized = await post('x'.repeat(5 * 1024), token);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ status: 'invalid_request' });
  });

  it('refuses a verified identity whose policy is for another environment, auditing the real reason', async () => {
    const token = await signToken(provider, {
      ...FLY_CLAIMS,
      app_name: 'fly-prod',
      app_id: '3333',
    });
    const response = await post(JSON.stringify({ tokens: entries(1) }), token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: 'identity_rejected' });
    expect(await issuedRows()).toEqual([]);
    const denials = await flushedDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ type: 'ai.kilo.sts.token.denied' });
    expect(denials[0].data.attributes).toMatchObject({
      channel: 'http',
      reason: 'environment_mismatch',
      workload: 'fly-prod',
    });
    expect(denials[0].data.attributes.audience).toBeUndefined();
  });
  it('logs a token that did not verify and records no denial', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await createProvider(FLY_ISSUER, config.issuer);
    const forged = await signToken(other, FLY_CLAIMS);
    const response = await post(JSON.stringify({ tokens: entries(1) }), forged);
    expect(response.status).toBe(401);
    expect(pending).toHaveLength(0);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(forged);
  });
});

/**
 * Team kilocode's slug issuer, which every shipped Vercel policy names. One key for the file: STS's
 * isolate keeps the verifier, and its key set, per policy index.
 */
let kilocode: TestProvider;

beforeAll(async () => {
  kilocode = await createProvider('https://oidc.vercel.com/kilocode', config.issuer);
});

/** An exchanged preview function token of a project of team kilocode. */
async function kilocodePreviewToken(project: string, projectId: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return await signToken(
    kilocode,
    {
      sub: `owner:kilocode:project:${project}:environment:preview`,
      owner: 'kilocode',
      owner_id: 'team_ItxRShuUkJaEd9GmXMEEgunb',
      project,
      project_id: projectId,
      environment: 'preview',
      act: { iat: issuedAt - 60, aud: 'https://vercel.com/kilocode' },
    },
    { issuedAt, expiresAt: issuedAt + 3600 }
  );
}

/** `POST /v1/token` with a provider token, under the shipped policies and registry. */
async function postShipped(token: string, request: MintRequest): Promise<Response> {
  vi.stubGlobal('fetch', providerFetch([kilocode]).fetch);
  const ctx = { waitUntil, passThroughOnException: () => undefined, props: {} };
  return await handleRequest(
    new Request(`${config.issuer}/v1/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    }),
    env,
    ctx as unknown as ExecutionContext,
    defaultMintAuthority
  );
}

describe('UTS grants of the shipped web policy', () => {
  const UTS_GRANTS = [
    { audience: 'uts-feed', scope: 'uts-feed:revocation.read' },
    { audience: 'uts', scope: 'uts:subjects.revoke' },
    { audience: 'uts', scope: 'uts:browser-sessions.end' },
    { audience: 'uts', scope: 'uts:api-credentials.revoke' },
  ];
  const web: MintCaller = {
    channel: 'http',
    workload: 'web',
    identity: 'vercel',
    attestationExp: null,
    claims: { provider: 'vercel' },
  };

  it.each(UTS_GRANTS)(
    'issues $scope in development and denies it in staging and production',
    async entry => {
      const request = { tokens: [entry] };
      const issued = await serveMint(env, config, {
        caller: web,
        request,
        waitUntil,
        authority: defaultMintAuthority,
      });
      expect(issued).toMatchObject({
        status: 'ok',
        tokens: [{ status: 'issued', audience: entry.audience }],
      });
      for (const environment of ['staging', 'production'] as const) {
        const denied = await serveMint(
          env,
          { ...config, environment },
          { caller: web, request, waitUntil, authority: defaultMintAuthority }
        );
        expect(denied).toEqual({
          status: 'ok',
          tokens: [{ status: 'denied', ...entry, reason: 'audience_not_allowed' }],
        });
      }
    }
  );

  it('issues a kilocode-app preview function a UTS feed token over HTTP in development', async () => {
    const response = await postShipped(
      await kilocodePreviewToken('kilocode-app', 'prj_AAnAlIuYPrpU0aDbT1kdm0ymL7hR'),
      { tokens: [UTS_GRANTS[0]] }
    );
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    if (result.status !== 'ok' || result.tokens[0].status !== 'issued') {
      throw new Error(`expected an issued token, got ${JSON.stringify(result)}`);
    }
    expect(decodeJwt(result.tokens[0].token)).toMatchObject({
      sub: 'service:web',
      aud: 'uts-feed',
      scope: 'uts-feed:revocation.read',
    });
  });
});

describe('UTS feed grant of the shipped ai-gateway policy', () => {
  const FEED = { audience: 'uts-feed', scope: 'uts-feed:revocation.read' };
  const GATEWAY_PROJECT_ID = 'prj_cFtsRYRBCm4qa8D35LC2j183FohC';

  it('issues a kilocode-ai-gateway preview function a UTS feed token over HTTP in development', async () => {
    const response = await postShipped(
      await kilocodePreviewToken('kilocode-ai-gateway', GATEWAY_PROJECT_ID),
      { tokens: [FEED] }
    );
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    if (result.status !== 'ok' || result.tokens[0].status !== 'issued') {
      throw new Error(`expected an issued token, got ${JSON.stringify(result)}`);
    }
    expect(decodeJwt(result.tokens[0].token)).toMatchObject({
      sub: 'service:ai-gateway',
      client_id: 'ai-gateway',
      env: 'development',
      aud: 'uts-feed',
      scope: 'uts-feed:revocation.read',
    });
    expect((await issuedRows())[0].data.attributes).toMatchObject({ identity: 'vercel' });
  });

  it('denies it every other audience and scope in development', async () => {
    const token = await kilocodePreviewToken('kilocode-ai-gateway', GATEWAY_PROJECT_ID);
    // One token per audience in a call, so the second uts and uts-feed entries go in a second call.
    const calls = [
      [
        { audience: 'uts', scope: 'uts:subjects.revoke', reason: 'audience_not_allowed' },
        {
          audience: 'usage-ingest',
          scope: 'usage-ingest:sts.canary',
          reason: 'scope_not_allowed',
        },
        { audience: 'web', scope: 'web:sts.canary', reason: 'audience_not_allowed' },
        { ...STS_DENIED_PROBE, reason: 'audience_not_allowed' },
        { audience: 'kilo-gateway', scope: 'kilo-gateway:inference', reason: 'unknown_scope' },
      ],
      [
        { audience: 'uts', scope: 'uts:token-exchange', reason: 'audience_not_allowed' },
        { audience: 'uts-feed', scope: 'uts-feed:revocation.write', reason: 'unknown_scope' },
      ],
    ];
    for (const denied of calls) {
      const response = await postShipped(token, {
        tokens: denied.map(({ audience, scope }) => ({ audience, scope })),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        tokens: denied.map(entry => ({ status: 'denied', ...entry })),
      });
    }
    expect(await issuedRows()).toEqual([]);
  });

  it('denies an ai-gateway caller the UTS feed at the staging and production mint', async () => {
    const gateway: MintCaller = {
      channel: 'http',
      workload: 'ai-gateway',
      identity: 'vercel',
      attestationExp: null,
      claims: { provider: 'vercel' },
    };
    for (const environment of ['staging', 'production'] as const) {
      expect(
        await serveMint(
          env,
          { ...config, environment },
          {
            caller: gateway,
            request: { tokens: [FEED] },
            waitUntil,
            authority: defaultMintAuthority,
          }
        )
      ).toEqual({
        status: 'ok',
        tokens: [{ status: 'denied', ...FEED, reason: 'audience_not_allowed' }],
      });
    }
    expect(await issuedRows()).toEqual([]);
  });

  it('refuses a kilocode-ai-gateway token from another project id', async () => {
    const otherProjectId = 'prj_cFtsRYRBCm4qa8D35LC2j183FohD';
    const token = await kilocodePreviewToken('kilocode-ai-gateway', otherProjectId);
    const response = await postShipped(token, { tokens: [FEED] });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: 'identity_rejected' });
    expect(await issuedRows()).toEqual([]);
    const denials = await flushedDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0].data.attributes).toMatchObject({
      channel: 'http',
      reason: 'unknown_workload',
      workload: `vercel:team_ItxRShuUkJaEd9GmXMEEgunb/${otherProjectId}`,
    });
  });
});

describe('Bouncer grants of the shipped web and ai-gateway policies', () => {
  const BOUNCER_SCOPES = [
    STS_BOUNCER_DECIDE,
    STS_BOUNCER_USAGE_WRITE,
    STS_BOUNCER_SIGNUP_DECIDE,
    STS_BOUNCER_SIGNUP_HISTORY,
  ];
  const GATEWAY_SCOPES = [STS_BOUNCER_DECIDE, STS_BOUNCER_USAGE_WRITE];

  function caller(workload: 'web' | 'ai-gateway'): MintCaller {
    return {
      channel: 'http',
      workload,
      identity: 'vercel',
      attestationExp: null,
      claims: { provider: 'vercel' },
    };
  }

  async function mintIn(
    environment: (typeof STS_ENVIRONMENTS)[number],
    workload: 'web' | 'ai-gateway',
    entry: { audience: string; scope: string }
  ) {
    return await serveMint(
      env,
      { ...config, environment },
      {
        caller: caller(workload),
        request: { tokens: [entry] },
        waitUntil,
        authority: defaultMintAuthority,
      }
    );
  }

  it.each([
    ...BOUNCER_SCOPES.map(entry => ['web', entry] as const),
    ...GATEWAY_SCOPES.map(entry => ['ai-gateway', entry] as const),
  ])('lets %s mint a %o token in production', async (workload, entry) => {
    // The policy admits the token, so the mint reaches the token signer. The test Worker's signers
    // belong to development and refuse a production request, so the answer is `unavailable`, never
    // a denial; the denials below show the same call refused by policy.
    expect(await mintIn('production', workload, entry)).toEqual({
      status: 'unavailable',
      retryAfterSeconds: TOKEN_SIGNER_RETRY_AFTER_SECONDS,
    });
    expect(await issuedRows()).toEqual([]);
    expect(await flushedDenials()).toEqual([]);
  });

  it.each([STS_BOUNCER_SIGNUP_DECIDE, STS_BOUNCER_SIGNUP_HISTORY])(
    'refuses ai-gateway %o in production, since the gateway sends no signup call',
    async entry => {
      expect(await mintIn('production', 'ai-gateway', entry)).toEqual({
        status: 'ok',
        tokens: [{ status: 'denied', ...entry, reason: 'scope_not_allowed' }],
      });
    }
  );

  it.each(BOUNCER_SCOPES)(
    'refuses web and ai-gateway %o outside production, where no Bouncer accepts it',
    async entry => {
      for (const environment of ['development', 'staging'] as const) {
        for (const workload of ['web', 'ai-gateway'] as const) {
          expect(await mintIn(environment, workload, entry)).toEqual({
            status: 'ok',
            tokens: [{ status: 'denied', ...entry, reason: 'audience_not_allowed' }],
          });
        }
      }
      expect(await issuedRows()).toEqual([]);
    }
  );
});

describe('phase 4 service scopes under the shipped policies', () => {
  // The O11y scopes, the Security Sync scopes and the web scopes each share one audience, and a
  // mint holds one token per audience, so each scope is asked for in a request of its own.
  const SERVICE_SCOPES = [
    STS_SECURE_PROXY_FORWARD,
    STS_USAGE_PUBLISH,
    STS_USAGE_RECORD,
    STS_O11Y_API_METRICS_WRITE,
    STS_O11Y_ALERTING_READ,
    STS_O11Y_ALERTING_WRITE,
    STS_SECURITY_SYNC_MANUAL_SYNC,
    STS_SECURITY_SYNC_DISMISS_FINDING,
    STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
  ];
  /**
   * The dual-accept grants, each the caller its receiver admits: usage-ingest's queue consumer
   * records usage at the web app; the AI gateway publishes LLM and Enkrypt usage and the web app
   * Exa usage to usage-ingest; both write O11y API metrics and only the web app reads and changes
   * O11y alerting; only the AI gateway forwards to the Secure Proxy. Every environment.
   */
  const GRANTED: Readonly<Record<string, readonly { audience: string; scope: string }[]>> = {
    'usage-ingest': [STS_USAGE_RECORD],
    'ai-gateway': [STS_USAGE_PUBLISH, STS_O11Y_API_METRICS_WRITE, STS_SECURE_PROXY_FORWARD],
    web: [
      STS_USAGE_PUBLISH,
      STS_O11Y_API_METRICS_WRITE,
      STS_O11Y_ALERTING_READ,
      STS_O11Y_ALERTING_WRITE,
    ],
  };
  const shipped = STS_ENVIRONMENTS.flatMap(environment =>
    defaultMintAuthority.policies
      .forEnvironment(environment)
      .map(policy => ({ environment, workload: policy.workload, policy }))
  );

  async function mintAsShipped(
    environment: (typeof STS_ENVIRONMENTS)[number],
    workload: string,
    entry: { audience: string; scope: string }
  ) {
    const result = await serveMint(
      env,
      { ...config, environment },
      {
        caller: { channel: 'http', workload, identity: 'test', attestationExp: null, claims: {} },
        request: { tokens: [entry] },
        waitUntil,
        authority: defaultMintAuthority,
      }
    );
    await Promise.all(pending);
    return result;
  }

  it('covers the web, usage-ingest, ai-gateway and o11y policies in every environment', () => {
    for (const environment of STS_ENVIRONMENTS) {
      const workloads = shipped
        .filter(entry => entry.environment === environment)
        .map(entry => entry.workload);
      expect(workloads).toEqual(
        expect.arrayContaining(['web', 'usage-ingest', 'ai-gateway', 'o11y'])
      );
    }
  });

  it('issues each dual-accept scope to exactly its caller in development', async () => {
    for (const [workload, granted] of Object.entries(GRANTED)) {
      for (const entry of granted) {
        const result = await mintAsShipped('development', workload, entry);
        if (result.status !== 'ok' || result.tokens[0]?.status !== 'issued') {
          throw new Error(
            `expected ${workload} to get ${entry.scope}, got ${JSON.stringify(result)}`
          );
        }
        expect(decodeJwt(result.tokens[0].token)).toMatchObject({
          sub: `service:${workload}`,
          env: 'development',
          aud: entry.audience,
          scope: entry.scope,
        });
      }
    }
  });

  it.each(['staging', 'production'] as const)(
    'hands each dual-accept scope of exactly its caller to the %s token signer',
    async environment => {
      // The test Worker's signer objects run as development and refuse a request for another
      // environment, so this records what the policy decision hands the signer instead of signing.
      const signed: Array<Parameters<TokenSignerDO['mint']>[0]> = [];
      const namespace = env.STS_TOKEN_SIGNER_DO;
      const spy = vi.spyOn(namespace, 'get').mockImplementation(
        id =>
          ({
            id,
            mint: async (request: Parameters<TokenSignerDO['mint']>[0]) => {
              signed.push(request);
              return { status: 'unavailable' };
            },
          }) as unknown as DurableObjectStub<TokenSignerDO>
      );
      try {
        for (const [workload, granted] of Object.entries(GRANTED)) {
          for (const entry of granted) {
            signed.length = 0;
            await mintAsShipped(environment, workload, entry);
            expect(signed).toEqual([
              expect.objectContaining({
                environment,
                workload,
                request: { tokens: [{ audience: entry.audience, scope: entry.scope }] },
              }),
            ]);
          }
        }
      } finally {
        spy.mockRestore();
      }
    }
  );

  it.each(shipped)(
    'refuses $workload in $environment every phase 4 service scope it is not granted, never as unknown_scope',
    async ({ environment, workload, policy }) => {
      const granted = GRANTED[workload] ?? [];
      for (const entry of SERVICE_SCOPES.filter(scope => !granted.includes(scope))) {
        // A policy holding the audience for another scope is refused the scope; otherwise the audience.
        const reason = policy.audiences.includes(entry.audience)
          ? 'scope_not_allowed'
          : 'audience_not_allowed';
        expect(await mintAsShipped(environment, workload, entry)).toEqual({
          status: 'ok',
          tokens: [{ status: 'denied', ...entry, reason }],
        });
      }
    }
  );

  it.each(STS_ENVIRONMENTS)(
    'refuses each dual-accept scope to the other receivers and callers in %s',
    async environment => {
      const refusals = [
        { workload: 'usage-ingest', entry: STS_USAGE_PUBLISH, reason: 'audience_not_allowed' },
        {
          workload: 'usage-ingest',
          entry: STS_O11Y_API_METRICS_WRITE,
          reason: 'audience_not_allowed',
        },
        { workload: 'web', entry: STS_USAGE_RECORD, reason: 'audience_not_allowed' },
        { workload: 'web', entry: STS_SECURE_PROXY_FORWARD, reason: 'audience_not_allowed' },
        { workload: 'ai-gateway', entry: STS_O11Y_ALERTING_READ, reason: 'scope_not_allowed' },
        { workload: 'ai-gateway', entry: STS_O11Y_ALERTING_WRITE, reason: 'scope_not_allowed' },
        { workload: 'ai-gateway', entry: STS_USAGE_RECORD, reason: 'audience_not_allowed' },
        { workload: 'o11y', entry: STS_O11Y_API_METRICS_WRITE, reason: 'audience_not_allowed' },
        {
          workload: 'usage-ingest',
          entry: STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
          reason: 'scope_not_allowed',
        },
      ];
      for (const { workload, entry, reason } of refusals) {
        expect(await mintAsShipped(environment, workload, entry)).toEqual({
          status: 'ok',
          tokens: [{ status: 'denied', ...entry, reason }],
        });
      }
    }
  );

  it.each(STS_ENVIRONMENTS)(
    'refuses the registered-only Security Sync workload its own scopes and the web dispatch in %s',
    async environment => {
      // cloudflare-security-sync.yaml is a registration: STS answers for it as for a name with no file.
      for (const entry of [
        STS_SECURITY_SYNC_MANUAL_SYNC,
        STS_SECURITY_SYNC_DISMISS_FINDING,
        STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH,
      ]) {
        expect(await mintAsShipped(environment, 'cloudflare-security-sync', entry)).toEqual({
          status: 'ok',
          tokens: [{ status: 'denied', ...entry, reason: 'unknown_workload' }],
        });
      }
    }
  );
});

describe('canary denied probe', () => {
  it('refuses the web function the reserved probe under the shipped policies and registry, and audits it as token.denied', async () => {
    const result = await serveMint(env, config, {
      caller: {
        channel: 'http',
        workload: STS_DENIED_PROBE_WORKLOAD,
        identity: 'vercel',
        attestationExp: Math.floor(Date.now() / 1000) + 3600,
        claims: { provider: 'vercel' },
      },
      request: {
        tokens: [STS_DENIED_PROBE, { audience: 'usage-ingest', scope: 'usage-ingest:sts.canary' }],
      },
      waitUntil,
      authority: defaultMintAuthority,
    });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.tokens[0]).toEqual({
      status: 'denied',
      ...STS_DENIED_PROBE,
      reason: STS_DENIED_PROBE_REASON,
    });
    // The denied probe does not affect the token the policy grants.
    expect(result.tokens[1]).toMatchObject({ status: 'issued', audience: 'usage-ingest' });

    const denials = await flushedDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      type: 'ai.kilo.sts.token.denied',
      data: {
        outcome: 'denied',
        outcomeDetail: 'audience_not_allowed',
        actor: { kind: 'service', id: 'web' },
        attributes: {
          channel: 'http',
          reason: 'audience_not_allowed',
          workload: 'web',
          audience: 'canary',
          scope: 'canary:denied-probe',
          count: 1,
        },
      },
    });
    expect(isStsDeniedProbe(denials[0].data.attributes)).toBe(true);
  });
});
