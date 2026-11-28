import { createExecutionContext } from 'cloudflare:test';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  BotTokenResponseSchema,
  KILO_GATEWAY_INFERENCE_SCOPE,
  UTS_AUTHORITY_SCOPE,
  UTS_BOT_TOKEN_MINT_SCOPE,
  UTS_BOT_TOKEN_PATH,
  UtsAccessTokenClaimsSchema,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { FEED_REFRESH_AFTER_MS, type JwksSource, createVerifier } from '@kilocode/verify';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BotTokenPolicy, BotTokenPolicySchema } from '../../src/bot-token/policy';
import { type BotTokenDeps, handleBotTokenRequest } from '../../src/bot-token/route';
import type { BotTokenAccess, BotTokenInput, BotTokenResult } from '../../src/bot-token/store';
import { handleRequest } from '../../src/http';
import { deployedStsCallers, resetStsCallerVerifier } from '../../src/sts-callers';
import { type SignerAccess, signerAccess } from '../../src/token/mint';
import { storeFailure } from './oauth-support';
import { keySet, utsFeed } from './support';
import { config, env } from './test-env';

/**
 * The bot-token mint at `POST /internal/bot-tokens` (src/bot-token/route.ts): STS tokens signed by
 * an Ed25519 key the test serves as the development STS key set to the deployed caller check, a
 * recording bot-token store, and the test pool's real signer objects for the issued token, which
 * `@kilocode/verify` then checks for its one audience.
 */

const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BOT = 'bot-internal-bouncer-watch';
const WORKLOAD = 'bouncer-watch';
const ORGANIZATIONS_READ = 'kilo-api:organizations.read';

const policy: BotTokenPolicy = BotTokenPolicySchema.parse({
  workload: WORKLOAD,
  account: BOT,
  org: ORG,
  scopes: [KILO_GATEWAY_INFERENCE_SCOPE, ORGANIZATIONS_READ],
  lifetimeSeconds: 3600,
});

const STS_KID = 'sts-test-0';
const stsPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const stsJwks: JwksSource = async () => ({
  body: {
    keys: [{ ...(await exportJWK(stsPair.publicKey)), kid: STS_KID, alg: 'EdDSA', use: 'sig' }],
  },
  age: null,
  oldestAge: null,
});
const unreachable: JwksSource = async () => {
  throw new Error('connection refused');
};

/** An STS service token of `workload` for audience `uts` and `scope`, as STS signs it. */
async function stsToken(workload: string, scope: string = UTS_BOT_TOKEN_MINT_SCOPE) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ client_id: workload, req: workload, scope, env: 'development' })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: STS_KID })
    .setIssuer(STS_ISSUERS.development)
    .setAudience('uts')
    .setSubject(`service:${workload}`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(stsPair.privateKey);
}

/** A bot-token store that answers `result` and records every call. */
function recordingStore(
  result: () => Promise<BotTokenResult> = async () => ({
    outcome: 'issued',
    tokenId: crypto.randomUUID(),
  })
) {
  const calls: BotTokenInput[] = [];
  const access: BotTokenAccess = work =>
    work({
      mint: async input => {
        calls.push(input);
        return await result();
      },
    });
  return { access, calls };
}

const unexpectedSigner: SignerAccess = async () => {
  throw new Error('unexpected signer call');
};

function deps(overrides: Partial<BotTokenDeps> = {}, jwks: JwksSource = stsJwks): BotTokenDeps {
  return {
    config,
    callers: deployedStsCallers(config, createExecutionContext(), () => jwks).botTokenCallers,
    scopes: utsScopeEntry,
    sign: signerAccess(env, config),
    mint: { status: 'on', policies: [policy], store: recordingStore().access },
    nowSeconds: () => Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function mintRequest(body: unknown, token: string | null, method = 'POST'): Request {
  return new Request(`${config.endpoints.issuer}${UTS_BOT_TOKEN_PATH}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const gatewayBody = { account: BOT, audience: 'kilo-gateway', scope: KILO_GATEWAY_INFERENCE_SCOPE };

async function errorOf(response: Response): Promise<unknown> {
  return await response.json();
}

afterEach(() => {
  resetStsCallerVerifier();
  vi.useRealTimers();
});

describe('the bot-token mint', () => {
  it('mints one token for a listed workload: the bot account, one audience, one scope, bot_user', async () => {
    const store = recordingStore();
    const response = await handleBotTokenRequest(
      mintRequest(gatewayBody, await stsToken(WORKLOAD)),
      deps({ mint: { status: 'on', policies: [policy], store: store.access } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = BotTokenResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      audience: 'kilo-gateway',
      scope: KILO_GATEWAY_INFERENCE_SCOPE,
    });
    expect(store.calls).toEqual([
      {
        environment: 'development',
        workload: WORKLOAD,
        accountId: BOT,
        orgId: ORG,
        scope: KILO_GATEWAY_INFERENCE_SCOPE,
        lifetimeSeconds: 3600,
      },
    ]);
    const claims = UtsAccessTokenClaimsSchema.parse(decodeJwt(body.access_token));
    expect(claims).toMatchObject({
      iss: config.endpoints.issuer,
      aud: 'kilo-gateway',
      sub: BOT,
      client_id: WORKLOAD,
      req: WORKLOAD,
      org: ORG,
      scope: KILO_GATEWAY_INFERENCE_SCOPE,
      env: 'development',
      bot_user: true,
    });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims).not.toHaveProperty('sid');
    expect(claims).not.toHaveProperty('act');
  });

  it('caps a scope that is not PAT-eligible at its registered lifetime', async () => {
    const store = recordingStore();
    const response = await handleBotTokenRequest(
      mintRequest(
        { account: BOT, audience: 'kilo-api', scope: ORGANIZATIONS_READ },
        await stsToken(WORKLOAD)
      ),
      deps({ mint: { status: 'on', policies: [policy], store: store.access } })
    );
    expect(response.status).toBe(200);
    expect(BotTokenResponseSchema.parse(await response.json()).expires_in).toBe(600);
    expect(store.calls.map(call => call.lifetimeSeconds)).toEqual([600]);
  });

  it('refuses a missing token, an STS token for another scope and a workload without a policy, before any statement', async () => {
    const store = recordingStore();
    const routeDeps = deps({
      mint: { status: 'on', policies: [policy], store: store.access },
      sign: unexpectedSigner,
    });
    const missing = await handleBotTokenRequest(mintRequest(gatewayBody, null), routeDeps);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');

    const wrongScope = await handleBotTokenRequest(
      mintRequest(gatewayBody, await stsToken(WORKLOAD, UTS_AUTHORITY_SCOPE)),
      routeDeps
    );
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.headers.get('WWW-Authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="${UTS_BOT_TOKEN_MINT_SCOPE}"`
    );

    for (const workload of ['intruder', 'web']) {
      const unknown = await handleBotTokenRequest(
        mintRequest(gatewayBody, await stsToken(workload)),
        routeDeps
      );
      expect(unknown.status).toBe(403);
      expect(await errorOf(unknown)).toEqual({ error: 'insufficient_scope' });
      expect(unknown.headers.get('WWW-Authenticate')).toBeNull();
    }
    expect(store.calls).toEqual([]);
  });

  it('refuses a malformed body, a wrong audience, an unknown bot account and a scope the policy lacks, before any statement', async () => {
    const store = recordingStore();
    const routeDeps = deps({
      mint: { status: 'on', policies: [policy], store: store.access },
      sign: unexpectedSigner,
    });
    const token = await stsToken(WORKLOAD);
    const answer = async (body: unknown) => {
      const response = await handleBotTokenRequest(mintRequest(body, token), routeDeps);
      return { status: response.status, body: await errorOf(response) };
    };
    expect(await answer({ ...gatewayBody, extra: true })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await answer({ ...gatewayBody, account: 'oauth/human-user' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await answer({ ...gatewayBody, audience: 'kilo-api' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_target' },
    });
    expect(await answer({ ...gatewayBody, account: 'bot-internal-other' })).toEqual({
      status: 403,
      body: { error: 'access_denied', error_description: 'unknown_account' },
    });
    for (const scope of ['kilo-api:notifications.read', 'kilo-api:unregistered']) {
      expect(await answer({ account: BOT, audience: 'kilo-api', scope })).toMatchObject({
        status: 400,
        body: { error: 'invalid_scope' },
      });
    }
    expect(store.calls).toEqual([]);
  });

  it('refuses a blocked bot account and a bot outside its organization without signing', async () => {
    for (const outcome of ['account_inactive', 'membership_denied'] as const) {
      const store = recordingStore(async () => ({ outcome }));
      const response = await handleBotTokenRequest(
        mintRequest(gatewayBody, await stsToken(WORKLOAD)),
        deps({
          mint: { status: 'on', policies: [policy], store: store.access },
          sign: unexpectedSigner,
        })
      );
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        error: 'access_denied',
        error_description: outcome,
      });
      expect(store.calls).toHaveLength(1);
    }
  });

  it('is not offered without policies or with a broken policy list, and takes only POST', async () => {
    const token = await stsToken(WORKLOAD);
    for (const mint of [
      { status: 'off' },
      { status: 'misconfigured', problems: ['BOT_TOKEN_POLICIES is not JSON'] },
    ] as const) {
      const response = await handleBotTokenRequest(mintRequest(gatewayBody, token), deps({ mint }));
      expect(response.status).toBe(404);
    }
    const get = await handleBotTokenRequest(mintRequest(null, token, 'GET'), deps());
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
  });

  it('answers 503 with Retry-After while a dependency fails, and 500 for a failure no retry fixes', async () => {
    const token = await stsToken(WORKLOAD);
    const statusOf = async (routeDeps: BotTokenDeps) =>
      (await handleBotTokenRequest(mintRequest(gatewayBody, token), routeDeps)).status;

    const keySetDown = await handleBotTokenRequest(
      mintRequest(gatewayBody, token),
      deps({}, unreachable)
    );
    expect(keySetDown.status).toBe(503);
    expect(Number(keySetDown.headers.get('Retry-After'))).toBeGreaterThan(0);
    resetStsCallerVerifier();

    const unbound = await handleBotTokenRequest(
      mintRequest(gatewayBody, token),
      deps({ mint: { status: 'on', policies: [policy], store: null } })
    );
    expect(unbound.status).toBe(503);
    expect(unbound.headers.get('Retry-After')).toBe('60');

    const failing =
      (failure: 'retryable' | 'permanent'): BotTokenAccess =>
      async () => {
        throw storeFailure(failure);
      };
    expect(
      await statusOf(
        deps({ mint: { status: 'on', policies: [policy], store: failing('retryable') } })
      )
    ).toBe(503);
    expect(
      await statusOf(
        deps({ mint: { status: 'on', policies: [policy], store: failing('permanent') } })
      )
    ).toBe(500);
    expect(await statusOf(deps({ sign: async () => ({ status: 'unavailable' }) }))).toBe(503);
    expect(await statusOf(deps({ sign: async () => ({ status: 'misconfigured' }) }))).toBe(500);
  });

  it('is served by the mint Worker from BOT_TOKEN_POLICIES, and not at all without it', async () => {
    const callers = deployedStsCallers(config, createExecutionContext(), () => stsJwks);
    const options = {
      authorizationHandoff: null,
      signer: unexpectedSigner,
      scopes: utsScopeEntry,
      recordingMailer: null,
      serviceTokens: callers.serviceTokens,
      botTokenCallers: callers.botTokenCallers,
      metadataFetcher: async () => {
        throw new Error('unexpected metadata fetch');
      },
      stsCallers: null,
    };
    const token = await stsToken(WORKLOAD);
    // A scope the policy lacks: refused after the policy and caller checks, before the statement.
    const lacking = { account: BOT, audience: 'kilo-api', scope: 'kilo-api:notifications.read' };
    const configured = { ...env, BOT_TOKEN_POLICIES: JSON.stringify([policy]) };
    const served = await handleRequest(
      mintRequest(lacking, token),
      configured,
      createExecutionContext(),
      options
    );
    expect(served.status).toBe(400);
    expect(await errorOf(served)).toMatchObject({ error: 'invalid_scope' });
    const intruder = await handleRequest(
      mintRequest(lacking, await stsToken('intruder')),
      configured,
      createExecutionContext(),
      options
    );
    expect(intruder.status).toBe(403);
    const off = await handleRequest(
      mintRequest(lacking, token),
      env,
      createExecutionContext(),
      options
    );
    expect(off.status).toBe(404);
  });
});

describe('a minted bot token at a verifier', () => {
  /**
   * A bot token from the route and the real signer, and `@kilocode/verify` verifiers for the
   * gateway and the Kilo API over the real UTS token keys and `feed`. The clock is faked only
   * after issuance, since the signer objects check `iat` against the real clock.
   */
  async function issuedTokenAndVerifiers() {
    const response = await handleBotTokenRequest(
      mintRequest(gatewayBody, await stsToken(WORKLOAD)),
      deps()
    );
    expect(response.status).toBe(200);
    const token = BotTokenResponseSchema.parse(await response.json()).access_token;
    const feed = await utsFeed();
    const tokenKeys = (await keySet()).keys;
    const background: Promise<unknown>[] = [];
    const verifierFor = (audience: string) =>
      createVerifier({
        audience,
        environment: 'development',
        resourceMetadataUrl: `${config.endpoints.issuer}/.well-known/oauth-protected-resource`,
        uts: {
          issuer: config.endpoints.issuer,
          jwks: async () => ({ body: { keys: [...tokenKeys, feed.key] }, age: 0, oldestAge: 0 }),
          scopeRegistry: (registryAudience, scope) => {
            const entry = utsScopeEntry(scope);
            return entry === null || entry.audience !== registryAudience ? null : entry;
          },
          revocation: feed.source,
        },
      });
    const verify = async (audience: string, scope: string) =>
      await verifierFor(audience).verify(
        `Bearer ${token}`,
        { issuer: 'uts', scope },
        { waitUntil: promise => background.push(promise), clientAddress: '203.0.113.7' }
      );
    const drain = async () => {
      await Promise.all(background.splice(0));
    };
    return { feed, verify, drain };
  }

  it('verifies for its one audience with the bot account as subject, and nowhere else', async () => {
    const { verify } = await issuedTokenAndVerifiers();
    const result = await verify('kilo-gateway', KILO_GATEWAY_INFERENCE_SCOPE);
    if (!result.ok) throw new Error(`gateway refused the bot token: ${result.reason}`);
    if (result.credential !== 'access_token') throw new Error('expected an access token');
    expect(result.caller).toMatchObject({ kind: 'user', subject: BOT, org: ORG, sessionId: null });
    expect(result.claims).toMatchObject({ bot_user: true, req: WORKLOAD });
    expect(await verify('kilo-api', ORGANIZATIONS_READ)).toMatchObject({ ok: false, status: 403 });
  });

  it('is refused once the bot account block reaches the verifier feed copy', async () => {
    const { feed, verify, drain } = await issuedTokenAndVerifiers();
    expect(await verify('kilo-gateway', KILO_GATEWAY_INFERENCE_SCOPE)).toMatchObject({ ok: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_000);
    // The entries `uts.apply_subject_operation` writes for an access block (test/db/bot-token.test.ts).
    const now = Date.now();
    feed.entries = [
      {
        kind: 'subject',
        id: BOT,
        revokedBefore: now,
        revokedAt: now,
        expiresAt: now + 70 * 60_000,
      },
      {
        kind: 'blocked_account',
        id: BOT,
        revokedBefore: null,
        revokedAt: now,
        expiresAt: now + 70 * 60_000,
      },
    ];
    vi.setSystemTime(Date.now() + FEED_REFRESH_AFTER_MS);
    await verify('kilo-gateway', KILO_GATEWAY_INFERENCE_SCOPE);
    await drain();
    expect(await verify('kilo-gateway', KILO_GATEWAY_INFERENCE_SCOPE)).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
