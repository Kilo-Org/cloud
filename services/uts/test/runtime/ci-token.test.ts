import {
  CiTokenResponseSchema,
  GITHUB_ACTIONS_ISSUER,
  KILO_GATEWAY_INFERENCE_SCOPE,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UTS_GRANT_TYPES,
  UTS_ID_TOKEN_TYPE_URN,
  UtsAccessTokenClaimsSchema,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import {
  FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_REFRESH_AFTER_MS,
  createVerifier,
} from '@kilocode/verify';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiExchangeService } from '../../src/ci/exchange';
import {
  GITHUB_ACTIONS_JWKS_URL,
  type GithubKeyState,
  githubKeys,
  newGithubKeyState,
} from '../../src/ci/github-keys';
import { CI_LEGACY_SUBJECT_REPOSITORY, type CiPolicy, CiPolicySchema } from '../../src/ci/policy';
import type { CiExchangeInput, CiExchangeResult, CiTokenAccess } from '../../src/ci/store';
import { authorizationServerMetadata } from '../../src/metadata/authorization-server';
import { handleOAuthRequest } from '../../src/oauth/routes';
import type { SignerAccess } from '../../src/token/mint';
import { errorOf, formRequest, oauthDeps, storeFailure, unexpectedStore } from './oauth-support';
import { keySet, utsFeed } from './support';
import { config } from './test-env';

/**
 * The CI token exchange at `/token` (src/ci/exchange.ts): GitHub OIDC tokens signed by RSA keys the
 * test holds and serves as GitHub's key set through a fake fetch, a recording CI token store, and
 * the test pool's real signer objects for the issued token.
 */

const REPOSITORY = 'Example-Org/example';
const REPOSITORY_ID = '111111';
const OWNER_ID = '222222';
const WORKFLOW = `${REPOSITORY}/.github/workflows/smoke.yml`;
const ACCOUNT = 'ci/example-bot';
const GATEWAY = 'urn:kilo:service:kilo-gateway';

const policy: CiPolicy = CiPolicySchema.parse({
  name: 'ci-example-smoke',
  repository: REPOSITORY,
  repositoryId: REPOSITORY_ID,
  repositoryOwnerId: OWNER_ID,
  environment: 'smoke',
  refs: ['refs/heads/main'],
  jobWorkflowRefs: [`${WORKFLOW}@refs/heads/main`],
  events: ['push', 'workflow_dispatch'],
  subject: ACCOUNT,
  scopes: [KILO_GATEWAY_INFERENCE_SCOPE],
  lifetimeSeconds: 3600,
});

type GithubSigningKey = { kid: string; privateKey: CryptoKey; jwk: Record<string, unknown> };

async function githubSigningKey(kid: string): Promise<GithubSigningKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

const keyA = await githubSigningKey('github-key-a');
const keyB = await githubSigningKey('github-key-b');

/** GitHub's key set as a fake fetch serves it; `answer` swaps what it serves, `calls` counts. */
function githubKeySet(initial: GithubSigningKey[]) {
  const served = {
    keys: initial,
    answer: 'ok' as 'ok' | 'fail' | 'redirect' | 'broken_body',
    calls: 0,
  };
  const fetcher: typeof fetch = async (input, init) => {
    served.calls += 1;
    expect(input).toBe(GITHUB_ACTIONS_JWKS_URL);
    expect(init?.redirect).toBe('manual');
    if (served.answer === 'fail') return new Response('down', { status: 503 });
    if (served.answer === 'redirect') {
      return new Response(null, { status: 302, headers: { Location: 'https://example.com/' } });
    }
    if (served.answer === 'broken_body') {
      // A 200 whose body resets after the headers, as a dropped connection does.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"keys": ['));
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, { status: 200 });
    }
    return Response.json({ keys: served.keys.map(key => key.jwk) });
  };
  return { served, fetcher };
}

type GithubClaims = Record<string, unknown>;

/** A GitHub OIDC token of the policy's workflow on main, valid 5 minutes unless overridden. */
async function githubToken(
  key: GithubSigningKey = keyA,
  overrides: GithubClaims = {},
  now = Math.floor(Date.now() / 1000)
): Promise<string> {
  const claims = {
    iss: GITHUB_ACTIONS_ISSUER,
    aud: config.endpoints.issuer,
    sub: `repo:Example-Org@${OWNER_ID}/example@${REPOSITORY_ID}:environment:smoke`,
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner: 'Example-Org',
    repository_owner_id: OWNER_ID,
    environment: 'smoke',
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
    event_name: 'workflow_dispatch',
    job_workflow_ref: `${WORKFLOW}@refs/heads/main`,
    run_id: '987654',
    run_attempt: '1',
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
    ...overrides,
  };
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: key.kid })
    .sign(key.privateKey);
}

/** A CI token store that answers `result` and records every call. */
function recordingStore(
  result: () => Promise<CiExchangeResult> = async () => ({
    outcome: 'issued',
    tokenId: crypto.randomUUID(),
  })
) {
  const calls: CiExchangeInput[] = [];
  const access: CiTokenAccess = work =>
    work({
      exchange: async input => {
        calls.push(input);
        return input.refusal === null ? await result() : { outcome: 'refused' };
      },
    });
  return { access, calls };
}

type Setup = {
  policies?: readonly CiPolicy[];
  store?: CiTokenAccess;
  fetcher?: typeof fetch;
  state?: GithubKeyState;
  now?: () => number;
  deniedAudits?: Map<string, number>;
};

function ciService(setup: Setup = {}): CiExchangeService {
  const now = setup.now ?? Date.now;
  return {
    status: 'on',
    policies: setup.policies ?? [policy],
    keys: githubKeys(
      setup.state ?? newGithubKeyState(),
      setup.fetcher ?? githubKeySet([keyA]).fetcher,
      now
    ),
    store: setup.store ?? recordingStore().access,
    deniedAudits: setup.deniedAudits ?? new Map(),
    now,
  };
}

function ciRequest(subject: string, fields: Record<string, string> = {}): Request {
  return formRequest('/token', {
    grant_type: UTS_GRANT_TYPES.tokenExchange,
    subject_token: subject,
    subject_token_type: UTS_ID_TOKEN_TYPE_URN,
    resource: GATEWAY,
    scope: KILO_GATEWAY_INFERENCE_SCOPE,
    ...fields,
  });
}

async function call(
  request: Request,
  ci: CiExchangeService = ciService(),
  sign?: SignerAccess
): Promise<Response> {
  const response = await handleOAuthRequest(
    request,
    '/token',
    oauthDeps(unexpectedStore, { ci, ...(sign === undefined ? {} : { sign }) })
  );
  if (response === null) throw new Error('the token endpoint did not answer');
  return response;
}

describe('the CI token exchange', () => {
  it('issues one token for the policy account, client and scope, for the policy lifetime, with no sid', async () => {
    const tokenId = crypto.randomUUID();
    const store = recordingStore(async () => ({ outcome: 'issued', tokenId }));
    const subject = await githubToken();
    const response = await call(ciRequest(subject), ciService({ store: store.access }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = CiTokenResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      issued_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: KILO_GATEWAY_INFERENCE_SCOPE,
    });
    expect(body).not.toHaveProperty('refresh_token');
    const { payload } = await jwtVerify(body.access_token, createLocalJWKSet(await keySet()), {
      issuer: config.endpoints.issuer,
      audience: 'kilo-gateway',
      typ: 'at+jwt',
    });
    const claims = UtsAccessTokenClaimsSchema.parse(payload);
    expect(claims).toMatchObject({
      sub: ACCOUNT,
      client_id: 'ci-example-smoke',
      scope: KILO_GATEWAY_INFERENCE_SCOPE,
      jti: tokenId,
      env: 'development',
    });
    expect(claims.exp - claims.iat).toBe(3600);
    for (const absent of ['sid', 'org', 'act', 'req', 'auth_time', 'amr'] as const) {
      expect(claims[absent]).toBeUndefined();
    }
    expect(store.calls).toEqual([
      {
        environment: 'development',
        policy: 'ci-example-smoke',
        accountId: ACCOUNT,
        scope: KILO_GATEWAY_INFERENCE_SCOPE,
        lifetimeSeconds: 3600,
        refusal: null,
        run: {
          repositoryId: REPOSITORY_ID,
          githubEnvironment: 'smoke',
          ref: 'refs/heads/main',
          sha: 'a'.repeat(40),
          eventName: 'workflow_dispatch',
          jobWorkflowRef: `${WORKFLOW}@refs/heads/main`,
          runId: '987654',
          runAttempt: '1',
          subjectTokenId: expect.any(String),
        },
      },
    ]);
  });

  it('accepts the requested access-token type', async () => {
    const response = await call(
      ciRequest(await githubToken(), { requested_token_type: UTS_ACCESS_TOKEN_TYPE_URN })
    );
    expect(response.status).toBe(200);
  });

  it('is not offered without policies, or with a policy var that breaks a rule', async () => {
    const subject = await githubToken();
    const off = await call(ciRequest(subject), { status: 'off' });
    expect(off.status).toBe(400);
    expect(await errorOf(off)).toBe('unsupported_grant_type');
    const misconfigured = await call(ciRequest(subject), {
      status: 'misconfigured',
      problems: ['policy ci-x: a scope is not registered'],
    });
    expect(await errorOf(misconfigured)).toBe('unsupported_grant_type');
  });

  it('refuses a malformed form, an unregistered scope and a resource of another service before any fetch', async () => {
    const keys = githubKeySet([keyA]);
    const ci = ciService({ fetcher: keys.fetcher });
    const subject = await githubToken();
    const malformed: Record<string, string>[] = [
      { scope: `${KILO_GATEWAY_INFERENCE_SCOPE} uts:probe.read` },
      { requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' },
      { client_id: 'kilo-cli' },
      { audience: 'kilo-gateway' },
    ];
    for (const fields of malformed) {
      expect(await errorOf(await call(ciRequest(subject, fields), ci))).toMatch(
        /^invalid_(request|scope)$/
      );
    }
    expect(await errorOf(await call(ciRequest(subject, { scope: 'gateway:unknown' }), ci))).toBe(
      'invalid_scope'
    );
    expect(
      await errorOf(await call(ciRequest(subject, { resource: 'urn:kilo:service:kilo-api' }), ci))
    ).toBe('invalid_target');
    expect(keys.served.calls).toBe(0);
  });

  it('refuses a token of another repository or owner without a statement', async () => {
    const store = recordingStore();
    const ci = ciService({ store: store.access });
    for (const overrides of [{ repository_id: '333333' }, { repository_owner_id: '444444' }]) {
      const response = await call(ciRequest(await githubToken(keyA, overrides)), ci);
      expect(await errorOf(response)).toBe('invalid_grant');
    }
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a workflow on another ref or in another GitHub environment without a statement', async () => {
    const store = recordingStore();
    const ci = ciService({ store: store.access });
    const branch = await githubToken(keyA, {
      ref: 'refs/heads/feature',
      job_workflow_ref: `${WORKFLOW}@refs/heads/feature`,
    });
    expect(await errorOf(await call(ciRequest(branch), ci))).toBe('invalid_grant');
    const otherEnvironment = await githubToken(keyA, { environment: 'release' });
    expect(await errorOf(await call(ciRequest(otherEnvironment), ci))).toBe('invalid_grant');
    expect(store.calls).toHaveLength(0);
  });

  it('refuses a listed workflow whose run breaks a binding, and audits it once per policy and reason a minute', async () => {
    let now = Date.now();
    const store = recordingStore();
    const ci = ciService({ store: store.access, now: () => now });
    const seconds = () => Math.floor(now / 1000);
    // The listed workflow, called from a run on another ref.
    const calledFromBranch = await githubToken(keyA, { ref: 'refs/heads/feature' }, seconds());
    // A fork author's event, the name-only subject, a subject of another environment.
    const forkEvent = await githubToken(keyA, { event_name: 'pull_request_target' }, seconds());
    const nameOnly = await githubToken(
      keyA,
      { sub: `repo:${REPOSITORY}:environment:smoke` },
      seconds()
    );
    for (const subject of [calledFromBranch, forkEvent, nameOnly]) {
      expect(await errorOf(await call(ciRequest(subject), ci))).toBe('invalid_grant');
    }
    expect(store.calls.map(input => [input.policy, input.refusal, input.accountId])).toEqual([
      ['ci-example-smoke', 'binding_mismatch', ACCOUNT],
    ]);
    now += 60_000;
    const later = await githubToken(keyA, { event_name: 'pull_request_target' }, seconds());
    expect(await errorOf(await call(ciRequest(later), ci))).toBe('invalid_grant');
    expect(store.calls.map(input => input.refusal)).toEqual([
      'binding_mismatch',
      'binding_mismatch',
    ]);
  });

  it('refuses a scope the policy does not grant with invalid_scope and a denied row', async () => {
    const store = recordingStore();
    const response = await call(
      ciRequest(await githubToken(), { scope: 'uts:probe.read', resource: 'urn:kilo:service:uts' }),
      ciService({ store: store.access })
    );
    expect(await errorOf(response)).toBe('invalid_scope');
    expect(store.calls.map(input => [input.refusal, input.scope])).toEqual([
      ['scope_not_granted', 'uts:probe.read'],
    ]);
  });

  it('answers a refusal whose denied row fails to write as the refusal', async () => {
    const access: CiTokenAccess = async () => {
      throw storeFailure('retryable');
    };
    const subject = await githubToken(keyA, { event_name: 'pull_request_target' });
    expect(await errorOf(await call(ciRequest(subject), ciService({ store: access })))).toBe(
      'invalid_grant'
    );
  });

  it('accepts the default subject only on a Kilo-Org/kilocode legacySubject policy', async () => {
    const kilocode = CiPolicySchema.parse({
      ...policy,
      name: 'ci-kilocode-smoke',
      repository: CI_LEGACY_SUBJECT_REPOSITORY.repository,
      repositoryId: CI_LEGACY_SUBJECT_REPOSITORY.repositoryId,
      repositoryOwnerId: CI_LEGACY_SUBJECT_REPOSITORY.repositoryOwnerId,
      jobWorkflowRefs: ['Kilo-Org/kilocode/.github/workflows/smoke-test.yml@refs/heads/main'],
    });
    const legacy: CiPolicy = { ...kilocode, legacySubject: true };
    const claims = {
      repository: CI_LEGACY_SUBJECT_REPOSITORY.repository,
      repository_id: CI_LEGACY_SUBJECT_REPOSITORY.repositoryId,
      repository_owner_id: CI_LEGACY_SUBJECT_REPOSITORY.repositoryOwnerId,
      job_workflow_ref: 'Kilo-Org/kilocode/.github/workflows/smoke-test.yml@refs/heads/main',
      sub: 'repo:Kilo-Org/kilocode:environment:smoke',
    };
    const ci = ciService({ policies: [legacy] });
    expect((await call(ciRequest(await githubToken(keyA, claims)), ci)).status).toBe(200);
    const withoutFlag = ciService({ policies: [kilocode] });
    expect(await errorOf(await call(ciRequest(await githubToken(keyA, claims)), withoutFlag))).toBe(
      'invalid_grant'
    );
  });

  it('refuses an expired token, another audience, an audience list, a future iat, another issuer and a bad signature', async () => {
    const store = recordingStore();
    const ci = ciService({ store: store.access });
    const now = Math.floor(Date.now() / 1000);
    const forged = await githubSigningKey(keyA.kid);
    for (const subject of [
      await githubToken(keyA, { iat: now - 900, nbf: now - 900, exp: now - 61 }),
      await githubToken(keyA, { aud: 'https://sts.example.com' }),
      await githubToken(keyA, { aud: [config.endpoints.issuer, 'https://sts.example.com'] }),
      await githubToken(keyA, { iat: now + 120, nbf: now }),
      await githubToken(keyA, { iss: 'https://token.example.com' }),
      await githubToken(keyA, { sha: 'not-a-sha' }),
      await githubToken(forged),
      'not.a.jwt',
    ]) {
      expect(await errorOf(await call(ciRequest(subject), ci))).toBe('invalid_grant');
    }
    expect(store.calls).toHaveLength(0);
  });

  /**
   * The key-set tests move the exchange's clock; the real signer objects check `iat` against the
   * real clock, so these tests sign with a stand-in.
   */
  const standInSigner: SignerAccess = async (_grantId, claims) => ({
    status: 'signed',
    tokens: claims.map(() => 'signed.by.stand-in'),
  });

  it('follows a GitHub key rotation: an unknown kid refreshes the key set at most once per 5 minutes', async () => {
    let now = Date.now();
    const keys = githubKeySet([keyA]);
    const ci = ciService({ fetcher: keys.fetcher, now: () => now });
    const seconds = () => Math.floor(now / 1000);
    const exchange = async (key: GithubSigningKey) =>
      await call(ciRequest(await githubToken(key, {}, seconds())), ci, standInSigner);
    expect((await exchange(keyA)).status).toBe(200);
    expect(keys.served.calls).toBe(1);
    // GitHub publishes key B and drops key A: the first token under B refreshes the copy.
    keys.served.keys = [keyB];
    now += 30_000;
    expect((await exchange(keyB)).status).toBe(200);
    expect(keys.served.calls).toBe(2);
    // Key A is gone; a token naming it makes no new fetch inside the 5 minutes.
    now += 30_000;
    expect(await errorOf(await exchange(keyA))).toBe('invalid_grant');
    expect(keys.served.calls).toBe(2);
    // After 5 minutes the copy is refreshed before use; key B still verifies.
    now += 5 * 60_000;
    expect((await exchange(keyB)).status).toBe(200);
    expect(keys.served.calls).toBe(3);
  });

  it('answers 503 when GitHub key set cannot be read, pauses fetches 10 seconds, and never follows a redirect', async () => {
    let now = Date.now();
    const keys = githubKeySet([keyA]);
    keys.served.answer = 'fail';
    const ci = ciService({ fetcher: keys.fetcher, now: () => now });
    const seconds = () => Math.floor(now / 1000);
    const exchange = async () =>
      await call(ciRequest(await githubToken(keyA, {}, seconds())), ci, standInSigner);
    const failed = await exchange();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('2');
    expect(await errorOf(failed)).toBe('temporarily_unavailable');
    now += 5_000;
    expect((await exchange()).status).toBe(503);
    expect(keys.served.calls).toBe(1);
    now += 5_000;
    keys.served.answer = 'redirect';
    expect((await exchange()).status).toBe(503);
    expect(keys.served.calls).toBe(2);
    now += 10_000;
    keys.served.answer = 'ok';
    expect((await exchange()).status).toBe(200);
    expect(keys.served.calls).toBe(3);
  });

  it('answers 503 when the key set body fails part way, and pauses fetches 10 seconds', async () => {
    let now = Date.now();
    const keys = githubKeySet([keyA]);
    keys.served.answer = 'broken_body';
    const ci = ciService({ fetcher: keys.fetcher, now: () => now });
    const exchange = async () =>
      await call(ciRequest(await githubToken(keyA, {}, Math.floor(now / 1000))), ci, standInSigner);
    const failed = await exchange();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('2');
    expect(await errorOf(failed)).toBe('temporarily_unavailable');
    now += 9_000;
    expect((await exchange()).status).toBe(503);
    expect(keys.served.calls).toBe(1);
    now += 1_000;
    keys.served.answer = 'ok';
    expect((await exchange()).status).toBe(200);
    expect(keys.served.calls).toBe(2);
  });

  it('refuses an inactive account with invalid_grant, and maps store and signer failures', async () => {
    const subject = await githubToken();
    const inactive = recordingStore(async () => ({ outcome: 'account_inactive' }));
    expect(
      await errorOf(await call(ciRequest(subject), ciService({ store: inactive.access })))
    ).toBe('invalid_grant');
    const failing =
      (failure: 'retryable' | 'permanent'): CiTokenAccess =>
      async () => {
        throw storeFailure(failure);
      };
    expect(
      (await call(ciRequest(subject), ciService({ store: failing('retryable') }))).status
    ).toBe(503);
    expect(
      (await call(ciRequest(subject), ciService({ store: failing('permanent') }))).status
    ).toBe(500);
    const unavailable: SignerAccess = async () => ({ status: 'unavailable' });
    expect((await call(ciRequest(subject), ciService(), unavailable)).status).toBe(503);
  });

  it('lists the token exchange in the metadata only while the CI exchange has policies', () => {
    const grantTypes = (ci: CiExchangeService) =>
      authorizationServerMetadata(
        config,
        { kind: 'ready', deps: oauthDeps(unexpectedStore, { ci }) },
        false,
        false
      ).grant_types_supported;
    expect(grantTypes(ciService())).toContain(UTS_GRANT_TYPES.tokenExchange);
    expect(grantTypes({ status: 'off' })).not.toContain(UTS_GRANT_TYPES.tokenExchange);
  });
});

describe('the emergency stop for issued CI tokens', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A CI token from the real exchange and signer, and a `@kilocode/verify` verifier for the
   * gateway over the real UTS token keys and `feed`. The clock is faked only after issuance, since
   * the signer objects check `iat` against the real clock.
   */
  async function issuedTokenAndVerifier() {
    const response = await call(ciRequest(await githubToken()));
    expect(response.status).toBe(200);
    const token = CiTokenResponseSchema.parse(await response.json()).access_token;
    const feed = await utsFeed();
    const tokenKeys = (await keySet()).keys;
    const verifier = createVerifier({
      audience: 'kilo-gateway',
      environment: 'development',
      resourceMetadataUrl: `${config.endpoints.issuer}/.well-known/oauth-protected-resource`,
      uts: {
        issuer: config.endpoints.issuer,
        jwks: async () => ({
          body: { keys: [...tokenKeys, feed.key] },
          age: 0,
          oldestAge: 0,
        }),
        scopeRegistry: (audience, scope) => {
          const entry = utsScopeEntry(scope);
          return entry === null || entry.audience !== audience ? null : entry;
        },
        revocation: feed.source,
      },
    });
    const background: Promise<unknown>[] = [];
    const verify = async () =>
      await verifier.verify(
        `Bearer ${token}`,
        { issuer: 'uts', scope: KILO_GATEWAY_INFERENCE_SCOPE },
        { waitUntil: promise => background.push(promise), clientAddress: '203.0.113.7' }
      );
    const drain = async () => {
      await Promise.all(background.splice(0));
    };
    return { feed, verify, drain };
  }

  it('refuses an already-issued CI token once the account block reaches the verifier feed copy', async () => {
    const { feed, verify, drain } = await issuedTokenAndVerifier();
    expect(await verify()).toMatchObject({ ok: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_000);
    // The entries `uts.apply_subject_operation` writes for an access block (test/db/ci-token.test.ts).
    const now = Date.now();
    feed.entries = [
      {
        kind: 'subject',
        id: ACCOUNT,
        revokedBefore: now,
        revokedAt: now,
        expiresAt: now + 70 * 60_000,
      },
      {
        kind: 'blocked_account',
        id: ACCOUNT,
        revokedBefore: null,
        revokedAt: now,
        expiresAt: now + 70 * 60_000,
      },
    ];
    // Not at once: inside 10 seconds of its last fetch the verifier answers from its copy.
    expect(await verify()).toMatchObject({ ok: true });
    // The first request 10 seconds after the last fetch refreshes the copy in the background.
    vi.setSystemTime(Date.now() + FEED_REFRESH_AFTER_MS);
    await verify();
    await drain();
    expect(await verify()).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an issued CI token rather than accept it once the feed head is over 60 seconds old', async () => {
    const { feed, verify } = await issuedTokenAndVerifier();
    expect(await verify()).toMatchObject({ ok: true });
    feed.reachable = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS + 1_000);
    expect(await verify()).toMatchObject({ ok: false, status: 503 });
  });
});
