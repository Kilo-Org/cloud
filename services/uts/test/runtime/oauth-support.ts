import { Buffer } from 'node:buffer';
import { type JWK, SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { IdentityStoreError } from '../../src/db/client';
import type { GrantStore, GrantsAccess, Minted } from '../../src/grants/store';
import { replayAccess } from '../../src/oauth/replay';
import type { OAuthDeps } from '../../src/oauth/routes';
import { signerAccess } from '../../src/token/mint';
import { config, env } from './test-env';

/** Helpers for the OAuth runtime tests: DPoP keys and proofs, a recording grant store, requests. */

export const TOKEN_URL = `${config.endpoints.issuer}/token`;
export const INTROSPECT_URL = `${config.endpoints.issuer}/introspect`;

export type DpopKey = { privateKey: CryptoKey; jwk: JWK; thumbprint: Buffer };

export async function dpopKey(): Promise<DpopKey> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const thumbprint = Buffer.from(await calculateJwkThumbprint(jwk, 'sha256'), 'base64url');
  return { privateKey, jwk, thumbprint };
}

export async function dpopProof(key: DpopKey, url = TOKEN_URL): Promise<string> {
  return await new SignJWT({
    jti: crypto.randomUUID(),
    htm: 'POST',
    htu: url,
    iat: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: key.jwk })
    .sign(key.privateKey);
}

/** A form POST to an issuer path; a field given as a list repeats. */
export function formRequest(
  path: string,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = {}
): Request {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  return new Request(`${config.endpoints.issuer}${path}`, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  });
}

type Call = { method: keyof GrantStore; input: unknown };

function recorded<Input, Output>(
  method: keyof GrantStore,
  calls: Call[],
  run: ((input: Input) => Promise<Output>) | undefined
): (input: Input) => Promise<Output> {
  return async input => {
    calls.push({ method, input });
    if (run === undefined) throw new Error(`unexpected ${method} call`);
    return await run(input);
  };
}

/**
 * A grant store that answers with `implementation` and records every call. A method it does not
 * implement fails the request, so a test sees any statement the endpoint was not meant to run.
 */
export function fakeGrants(implementation: Partial<GrantStore> = {}) {
  const calls: Call[] = [];
  const store: GrantStore = {
    findThirdPartyClient: recorded(
      'findThirdPartyClient',
      calls,
      implementation.findThirdPartyClient
    ),
    issueCode: recorded('issueCode', calls, implementation.issueCode),
    exchangeCode: recorded('exchangeCode', calls, implementation.exchangeCode),
    refreshFirstParty: recorded('refreshFirstParty', calls, implementation.refreshFirstParty),
    refreshThirdParty: recorded('refreshThirdParty', calls, implementation.refreshThirdParty),
    revoke: recorded('revoke', calls, implementation.revoke),
    introspect: recorded('introspect', calls, implementation.introspect),
  };
  const access: GrantsAccess = work => work(store);
  return { access, calls };
}

export function storeFailure(failure: 'retryable' | 'permanent'): IdentityStoreError {
  return new IdentityStoreError(failure, {
    sqlState: failure === 'retryable' ? '08006' : '23514',
    constraint: undefined,
    table: undefined,
    systemCode: undefined,
  });
}

export function minted(overrides: Partial<Minted> = {}): Minted {
  return {
    subjectId: 'oauth/runtime-user',
    orgId: null,
    authTime: new Date(Date.now() - 60_000),
    amr: ['passkey'],
    tokenIds: [crypto.randomUUID()],
    scopes: ['gateway:models.read'],
    ...overrides,
  };
}

/** Endpoint dependencies with the real signer and replay objects of the test pool. */
export function oauthDeps(grants: GrantsAccess, overrides: Partial<OAuthDeps> = {}): OAuthDeps {
  return {
    config,
    grants,
    sign: signerAccess(env, config),
    replay: replayAccess(env, config),
    handoff: null,
    deviceCodeGrant: null,
    ...overrides,
  };
}

export async function errorOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
}
