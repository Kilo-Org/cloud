/**
 * Unit tests for the Worker-only model-route bearer verification.
 *
 * The forbidden-claim fixtures must be signed by hand: `signKiloToken` cannot
 * produce them, because `kiloTokenPayload` omits `tokenPurpose` and
 * `credentialExchange` and `.strict()` rejects unknown keys. That is exactly
 * why the raw payload is decoded and checked separately.
 */

import { createHmac } from 'node:crypto';
import { signKiloToken } from '@kilocode/worker-utils';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_MODEL_TOKEN_CLAIMS,
  decodeTrustedPayload,
  resolveNextAuthSecret,
  verifyModelRouteBearer,
  type NextAuthSecretBinding,
} from '../../e2e/fake-llm-model-auth.js';

const SECRET = 'model-auth-test-secret';
const NOW_SECONDS = Math.floor(Date.now() / 1000);

/**
 * Declared locally so deleting a claim from the implementation cannot silently
 * delete its test case; the test asserts this list equals the imported one.
 */
const EXPECTED_FORBIDDEN_CLAIMS = [
  'aud',
  'tokenPurpose',
  'credentialExchange',
  'runtimeAdmission',
  'runtimeAuthorization',
  'organizationId',
  'organizationRole',
] as const;

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signRaw(payload: Record<string, unknown>, secret = SECRET): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function ordinaryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    kiloUserId: 'user_1',
    apiTokenPepper: 'pepper',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 600,
    ...overrides,
  };
}

function forbiddenClaimValue(claim: string): unknown {
  switch (claim) {
    case 'aud':
      return 'kilo-api';
    case 'tokenPurpose':
      return 'human-api';
    case 'credentialExchange':
      return true;
    case 'runtimeAdmission':
      return { source: 'user', authorizationUserId: 'user_1', authorizationPepper: null };
    case 'runtimeAuthorization':
      return {
        id: '11111111-1111-4111-8111-111111111111',
        resourceKind: 'cloud-agent-next',
        resourceId: 'resource_1',
      };
    case 'organizationId':
      return 'org_1';
    case 'organizationRole':
      return 'member';
    default:
      throw new Error(`unhandled claim fixture: ${claim}`);
  }
}

describe('resolveNextAuthSecret', () => {
  it('normalizes missing and empty bindings to null', async () => {
    await expect(resolveNextAuthSecret(undefined)).resolves.toBeNull();
    await expect(resolveNextAuthSecret('')).resolves.toBeNull();
    await expect(resolveNextAuthSecret({ get: async () => null })).resolves.toBeNull();
    await expect(resolveNextAuthSecret({ get: async () => '' })).resolves.toBeNull();
  });

  it('reads a plain string and a Secrets Store style binding', async () => {
    await expect(resolveNextAuthSecret('plain-secret')).resolves.toBe('plain-secret');
    await expect(resolveNextAuthSecret({ get: async () => 'store-secret' })).resolves.toBe(
      'store-secret'
    );
  });
});

describe('decodeTrustedPayload', () => {
  it('decodes a base64url payload segment including non-ASCII text', () => {
    const payload = { version: 3, kiloUserId: 'user_ü', tokenPurpose: 'human-api' };
    expect(decodeTrustedPayload(signRaw(payload))).toEqual(payload);
  });

  it('throws on a token without a payload segment', () => {
    expect(() => decodeTrustedPayload('not-a-jwt')).toThrow();
  });
});

describe('verifyModelRouteBearer', () => {
  it('accepts a valid ordinary personal token', async () => {
    const { token } = await signKiloToken({
      userId: 'user_1',
      pepper: 'pepper',
      secret: SECRET,
      expiresInSeconds: 600,
    });

    const result = await verifyModelRouteBearer(`Bearer ${token}`, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.kiloUserId).toBe('user_1');
  });

  it('accepts the same token through a Secrets Store style binding', async () => {
    const { token } = await signKiloToken({
      userId: 'user_1',
      pepper: 'pepper',
      secret: SECRET,
      expiresInSeconds: 600,
    });
    const binding: NextAuthSecretBinding = { get: async () => SECRET };
    const result = await verifyModelRouteBearer(`Bearer ${token}`, binding);
    expect(result.ok).toBe(true);
  });

  it('rejects a missing bearer before it needs the secret', async () => {
    await expect(verifyModelRouteBearer(undefined, undefined)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
    await expect(verifyModelRouteBearer('', undefined)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('reports 500 when the secret binding is unavailable or empty', async () => {
    await expect(verifyModelRouteBearer('Bearer abc.def.ghi', undefined)).resolves.toMatchObject({
      ok: false,
      status: 500,
    });
    await expect(verifyModelRouteBearer('Bearer abc.def.ghi', '')).resolves.toMatchObject({
      ok: false,
      status: 500,
    });
  });

  it('rejects a malformed bearer', async () => {
    await expect(verifyModelRouteBearer('Bearer not-a-jwt', SECRET)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { token } = await signKiloToken({
      userId: 'user_1',
      pepper: 'pepper',
      secret: 'some-other-secret',
      expiresInSeconds: 600,
    });
    await expect(verifyModelRouteBearer(`Bearer ${token}`, SECRET)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects an expired token', async () => {
    const token = signRaw(ordinaryPayload({ iat: NOW_SECONDS - 1200, exp: NOW_SECONDS - 600 }));
    await expect(verifyModelRouteBearer(`Bearer ${token}`, SECRET)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects each forbidden claim independently', async () => {
    expect([...EXPECTED_FORBIDDEN_CLAIMS]).toEqual([...FORBIDDEN_MODEL_TOKEN_CLAIMS]);
    for (const claim of EXPECTED_FORBIDDEN_CLAIMS) {
      const token = signRaw(ordinaryPayload({ [claim]: forbiddenClaimValue(claim) }));
      const result = await verifyModelRouteBearer(`Bearer ${token}`, SECRET);
      expect(result.ok, `claim ${claim} must be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.status, `claim ${claim} status`).toBe(401);
        // `aud` is already rejected by verifyKiloToken itself; every other
        // forbidden claim is only visible in the raw decoded payload.
        if (claim !== 'aud') {
          expect(result.message, `claim ${claim} message`).toContain(claim);
        }
      }
    }
  });

  it('accepts a correctly signed token whose pepper claim is explicitly null', async () => {
    const token = signRaw(ordinaryPayload({ apiTokenPepper: null }));
    const result = await verifyModelRouteBearer(`Bearer ${token}`, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.kiloUserId).toBe('user_1');
  });

  it('rejects a token with an absent pepper claim', async () => {
    const withoutPepper = ordinaryPayload();
    delete withoutPepper.apiTokenPepper;
    await expect(
      verifyModelRouteBearer(`Bearer ${signRaw(withoutPepper)}`, SECRET)
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      message: 'model token pepper is not usable',
    });
  });
});
