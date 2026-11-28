import { createExecutionContext } from 'cloudflare:test';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import {
  UTS_APP_EVENTS_SCOPE,
  UTS_AUTHORITY_SCOPE,
  UTS_BOT_TOKEN_MINT_SCOPE,
  UTS_ENDPOINTS,
  UTS_TOKEN_EXCHANGE_ACTOR,
  UTS_TOKEN_EXCHANGE_STS_SCOPE,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { JWKS_JITTER, JWKS_RETRY_MS, type JwksSource } from '@kilocode/verify';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { UtsConfig } from '../../src/env';
import type { StsCallerVerifier } from '../../src/exchange/endpoint';
import {
  deployedStsCallers,
  resetStsCallerVerifier,
  STS_CALLER_WORKLOADS,
} from '../../src/sts-callers';

const KID = 'sts-test-0';
const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'EdDSA', use: 'sig' };

const served: JwksSource = async () => ({ body: { keys: [jwk] }, age: null, oldestAge: null });
const unreachable: JwksSource = async () => {
  throw new Error('connection refused');
};

function configFor(environment: UtsEnvironment): UtsConfig {
  return {
    environment,
    endpoints: UTS_ENDPOINTS[environment],
    jurisdiction: environment === 'development' ? 'none' : 'eu',
    secretsSource: 'worker',
    relyingParty: { rpId: 'localhost', origins: ['http://localhost:8800'] },
    managerBaseUrl: null,
    loginRotation: { status: 'off' },
  };
}

async function stsToken(
  workload: string,
  scope: string,
  options: { environment?: UtsEnvironment; audience?: string; foreignKey?: boolean } = {}
): Promise<string> {
  const environment = options.environment ?? 'staging';
  const key = options.foreignKey
    ? (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey
    : pair.privateKey;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ client_id: workload, req: workload, scope, env: environment })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
    .setIssuer(STS_ISSUERS[environment])
    .setAudience(options.audience ?? 'uts')
    .setSubject(`service:${workload}`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

const callers = (environment: UtsEnvironment, jwks: JwksSource = served) =>
  deployedStsCallers(configFor(environment), createExecutionContext(), () => jwks);

/** The exchange check of an environment that offers the exchange. */
function exchangeOf(checks: { stsCallers: StsCallerVerifier | null }): StsCallerVerifier {
  if (checks.stsCallers === null) throw new Error('this environment offers no exchange');
  return checks.stsCallers;
}

afterEach(() => {
  resetStsCallerVerifier();
});

describe('deployed STS callers', () => {
  it('keeps both allow-lists empty in production and lists the web app and the broker elsewhere', () => {
    expect(STS_CALLER_WORKLOADS).toEqual({
      production: { exchange: [], internal: [] },
      staging: { exchange: [UTS_TOKEN_EXCHANGE_ACTOR], internal: ['web'] },
      development: { exchange: [UTS_TOKEN_EXCHANGE_ACTOR], internal: ['web'] },
    });
  });

  it('admits the web app on every internal route scope', async () => {
    for (const scope of [UTS_AUTHORITY_SCOPE, UTS_APP_EVENTS_SCOPE, 'uts:subjects.revoke']) {
      const token = await stsToken('web', scope);
      expect(await callers('staging').serviceTokens(`Bearer ${token}`, scope)).toEqual({
        status: 'verified',
        workload: 'web',
      });
    }
  });

  it('refuses a missing credential, another scope, another audience and a foreign key', async () => {
    const { serviceTokens } = callers('staging');
    expect(await serviceTokens(null, UTS_AUTHORITY_SCOPE)).toEqual({ status: 'missing' });
    const other = await stsToken('web', UTS_APP_EVENTS_SCOPE);
    expect(await serviceTokens(`Bearer ${other}`, UTS_AUTHORITY_SCOPE)).toEqual({
      status: 'insufficient_scope',
    });
    const audience = await stsToken('web', UTS_AUTHORITY_SCOPE, { audience: 'uts-feed' });
    expect(await serviceTokens(`Bearer ${audience}`, UTS_AUTHORITY_SCOPE)).not.toEqual(
      expect.objectContaining({ status: 'verified' })
    );
    const forged = await stsToken('web', UTS_AUTHORITY_SCOPE, { foreignKey: true });
    expect(await serviceTokens(`Bearer ${forged}`, UTS_AUTHORITY_SCOPE)).toEqual({
      status: 'invalid',
    });
  });

  it('refuses a workload the environment does not list, and every caller in production, by workload', async () => {
    const intruder = await stsToken('cloud-agent', UTS_AUTHORITY_SCOPE);
    expect(
      await callers('staging').serviceTokens(`Bearer ${intruder}`, UTS_AUTHORITY_SCOPE)
    ).toEqual({ status: 'workload_refused', workload: 'cloud-agent' });
    const web = await stsToken('web', UTS_AUTHORITY_SCOPE, { environment: 'production' });
    expect(await callers('production').serviceTokens(`Bearer ${web}`, UTS_AUTHORITY_SCOPE)).toEqual(
      { status: 'workload_refused', workload: 'web' }
    );
    // Production offers no exchange while it admits no exchange caller.
    expect(callers('production').stsCallers).toBeNull();
  });

  it('hands the bot-token route any service workload on its scope, in every environment, and leaves the allow-list to its policies', async () => {
    for (const environment of ['production', 'staging'] as const) {
      const watch = await stsToken('bouncer-watch', UTS_BOT_TOKEN_MINT_SCOPE, { environment });
      expect(
        await callers(environment).botTokenCallers(`Bearer ${watch}`, UTS_BOT_TOKEN_MINT_SCOPE)
      ).toEqual({ status: 'verified', workload: 'bouncer-watch' });
      resetStsCallerVerifier();
    }
    const { botTokenCallers, serviceTokens } = callers('staging');
    const other = await stsToken('bouncer-watch', UTS_AUTHORITY_SCOPE);
    expect(await botTokenCallers(`Bearer ${other}`, UTS_BOT_TOKEN_MINT_SCOPE)).toEqual({
      status: 'insufficient_scope',
    });
    // The bot scope does not open the web app's routes to the workload.
    const watch = await stsToken('bouncer-watch', UTS_BOT_TOKEN_MINT_SCOPE);
    expect(await serviceTokens(`Bearer ${watch}`, UTS_BOT_TOKEN_MINT_SCOPE)).toEqual({
      status: 'workload_refused',
      workload: 'bouncer-watch',
    });
  });

  it('admits the broker on the exchange scope only', async () => {
    const stsCallers = exchangeOf(callers('staging'));
    const broker = await stsToken(UTS_TOKEN_EXCHANGE_ACTOR, UTS_TOKEN_EXCHANGE_STS_SCOPE);
    expect(await stsCallers(broker)).toEqual({
      status: 'verified',
      caller: { workload: UTS_TOKEN_EXCHANGE_ACTOR, scope: UTS_TOKEN_EXCHANGE_STS_SCOPE },
    });
    const otherScope = await stsToken(UTS_TOKEN_EXCHANGE_ACTOR, UTS_AUTHORITY_SCOPE);
    expect(await stsCallers(otherScope)).toEqual({ status: 'invalid' });
    const web = await stsToken('web', UTS_TOKEN_EXCHANGE_STS_SCOPE);
    expect(await stsCallers(web)).toEqual({ status: 'invalid' });
  });

  it('fails closed with unavailable and the wait verify names while the STS key set cannot be read', async () => {
    const { serviceTokens } = callers('staging', unreachable);
    const stsCallers = exchangeOf(callers('staging', unreachable));
    const web = await stsToken('web', UTS_AUTHORITY_SCOPE);
    const check = await serviceTokens(`Bearer ${web}`, UTS_AUTHORITY_SCOPE);
    if (check.status !== 'unavailable')
      throw new Error(`expected unavailable, got ${check.status}`);
    // verify names what is left of its wait (at most JWKS_RETRY_MS plus JWKS_JITTER), never the
    // fixed default.
    expect(check.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(check.retryAfterSeconds).toBeLessThanOrEqual(
      Math.ceil((JWKS_RETRY_MS * (1 + JWKS_JITTER)) / 1000)
    );
    const broker = await stsToken(UTS_TOKEN_EXCHANGE_ACTOR, UTS_TOKEN_EXCHANGE_STS_SCOPE);
    expect(await stsCallers(broker)).toEqual({ status: 'unavailable' });
  });
});
