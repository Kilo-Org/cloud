import type { AttestationAccess } from '../../src/attest/store';
import { type UtsScopeEntry, utsScopeEntry } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { type JWK, SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { IdentityStoreError } from '../../src/db/client';
import type { GrantStore, GrantsAccess, Minted } from '../../src/grants/store';
import type { OAuthDeps } from '../../src/oauth/routes';
import type { FeedEntry } from '../../src/revocation/entries';
import type { FeedPublish, PublishOutcome } from '../../src/revocation/publish';
import type { ScopeRegistry } from '../../src/scopes/policy';
import { signerAccess } from '../../src/token/mint';
import { config, env, noSignInMethods } from './test-env';

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
    issueCode: recorded('issueCode', calls, implementation.issueCode),
    exchangeCode: recorded('exchangeCode', calls, implementation.exchangeCode),
    refreshFirstParty: recorded('refreshFirstParty', calls, implementation.refreshFirstParty),
    refreshThirdParty: recorded('refreshThirdParty', calls, implementation.refreshThirdParty),
    revoke: recorded('revoke', calls, implementation.revoke),
    introspect: recorded('introspect', calls, implementation.introspect),
    exchangeDelegated: recorded('exchangeDelegated', calls, implementation.exchangeDelegated),
    exchangeHomeWidget: recorded('exchangeHomeWidget', calls, implementation.exchangeHomeWidget),
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
    orgRole: null,
    authTime: new Date(Date.now() - 60_000),
    amr: ['passkey'],
    tokenIds: [crypto.randomUUID()],
    scopes: ['gateway:models.read'],
    ...overrides,
  };
}

/** A fixture scope that the CLI and any third-party client may hold, 10 minutes, any user. */
const fixtureScope = (audience: string): UtsScopeEntry => ({
  audience,
  maxLifetimeSeconds: 600,
  allowedClients: ['kilo-cli', 'third_party'],
  subjects: { kind: 'any_user' },
  thirdPartySafe: true,
  stepUp: false,
  patEligible: false,
  privileged: false,
  requiresSession: false,
  requiresOrgClaim: false,
  delegable: false,
  issuance: 'grant',
  delegatesTo: [],
  consentText: `Use the ${audience} fixture`,
});

const FIXTURE_SCOPES: Readonly<Record<string, UtsScopeEntry>> = {
  'gateway:models.read': fixtureScope('gateway'),
  'kilo-chat:messages.read': fixtureScope('kilo-chat'),
  'mcp:tools.read': fixtureScope('mcp'),
};

/**
 * The scope registry plus the fixture scopes these tests mint: the registry holds no
 * third-party-safe scope yet, and the flows need one.
 */
export const testScopes: ScopeRegistry = scope =>
  utsScopeEntry(scope) ??
  (Object.hasOwn(FIXTURE_SCOPES, scope) ? (FIXTURE_SCOPES[scope] ?? null) : null);

/**
 * A feed publisher that records every batch and answers `outcome`, so a test sees what an
 * endpoint published after its statement.
 */
export function recordingPublisher(outcome: PublishOutcome = 'published') {
  const batches: FeedEntry[][] = [];
  const publish: FeedPublish = async entries => {
    batches.push([...entries]);
    return outcome;
  };
  return { publish, batches };
}

/** A feed entry as a revoking statement returns it. */
export function grantEntry(id: string = crypto.randomUUID()): FeedEntry {
  const now = Date.now();
  return { kind: 'grant', id, revokedBefore: null, revokedAt: now, expiresAt: now + 1_200_000 };
}

/** A store access that fails the request: a test that reaches it ran a statement it did not expect. */
export const unexpectedStore = async (): Promise<never> => {
  throw new Error('unexpected store call');
};

/** An attestation store that only marks codes exempt, as development without config does. */
export const exemptOnlyStore: AttestationAccess = work =>
  work({
    claim: async () => {
      throw new Error('unexpected attestation claim');
    },
    settle: async () => {
      throw new Error('unexpected attestation settle');
    },
    exempt: async () => undefined,
  });

/** Endpoint dependencies with the real signer objects of the test pool. */
export function oauthDeps(grants: GrantsAccess, overrides: Partial<OAuthDeps> = {}): OAuthDeps {
  return {
    config,
    grants,
    sign: signerAccess(env, config),
    scopes: testScopes,
    publish: recordingPublisher().publish,
    handoff: async () => {
      throw new Error('unexpected hand-off');
    },
    device: { status: 'off' },
    homeWidget: { status: 'off' },
    signIn: { config, signIn: unexpectedStore, methods: noSignInMethods },
    tickets: { config, tickets: unexpectedStore },
    clients: async () => {
      throw new Error('unexpected client lookup');
    },
    thirdParty: unexpectedStore,
    exchange: null,
    // The runtime pool runs in development without attestation config (src/attest/config.ts):
    // a kilo-mobile exchange only marks its code exempt first.
    attestation: { kind: 'unattested_development', store: exemptOnlyStore },
    web: {
      config,
      keys: async () => ({ status: 'unconfigured' }),
      sessions: unexpectedStore,
      sign: signerAccess(env, config),
      scopes: testScopes,
      publish: recordingPublisher().publish,
      bridge: { status: 'off' },
      windows: new Map(),
      now: Date.now,
    },
    ...overrides,
  };
}

export async function errorOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '';
}
