import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from 'jose';
import { describe, expect, it } from 'vitest';
import {
  UTS_ENDPOINTS,
  UTS_JWKS_MAX_AGE_SECONDS,
  UTS_JWKS_OLDEST_AGE_HEADER,
  UTS_JWKS_STALE_IF_ERROR_SECONDS,
} from './environment';
import {
  signerOfTokenKid,
  tokenKid,
  UtsJwksSchema,
  UtsTokenKidSchema,
  type UtsPublicJwk,
} from './jwks';
import { AuthorizationServerMetadataSchema } from './metadata';
import {
  SignerKeysAnswerSchema,
  SignerKeysReadSchema,
  UTS_SIGNER_KEYS_ENTRYPOINT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type SignerKeysEntry,
} from './signer-keys';

const THUMBPRINT = 'A'.repeat(43);

function jwk(signer: number, x = THUMBPRINT): UtsPublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', x, kid: tokenKid(signer, x), alg: 'EdDSA', use: 'sig' };
}

describe('UTS endpoints', () => {
  it('fixes the issuer and key set URL of each environment', () => {
    expect(UTS_ENDPOINTS).toEqual({
      production: {
        issuer: 'https://uts.kiloapps.io',
        feedOrigin: 'https://uts-feed.kiloapps.io',
        jwksUri: 'https://uts-feed.kiloapps.io/.well-known/jwks.json',
      },
      staging: {
        issuer: 'https://uts-staging.kiloapps.io',
        feedOrigin: 'https://uts-feed-staging.kiloapps.io',
        jwksUri: 'https://uts-feed-staging.kiloapps.io/.well-known/jwks.json',
      },
      development: {
        issuer: 'http://localhost:8800',
        feedOrigin: 'http://localhost:8801',
        jwksUri: 'http://localhost:8801/.well-known/jwks.json',
      },
    });
  });

  it('fixes the key-set cache limits and the oldest-age header name', () => {
    expect(UTS_JWKS_MAX_AGE_SECONDS).toBe(300);
    expect(UTS_JWKS_STALE_IF_ERROR_SECONDS).toBe(86400);
    expect(UTS_JWKS_OLDEST_AGE_HEADER).toBe('Kilo-Key-Set-Oldest-Age');
  });
});

describe('token kids', () => {
  it('name the signer and the key thumbprint', () => {
    const kid = tokenKid(7, THUMBPRINT);
    expect(kid).toBe(`uts-token-07-${THUMBPRINT}`);
    expect(signerOfTokenKid(kid)).toBe(7);
    expect(UtsTokenKidSchema.safeParse(kid).success).toBe(true);
  });

  it('reject signers outside the 16 and values that are not token kids', () => {
    expect(() => tokenKid(16, THUMBPRINT)).toThrow();
    expect(() => tokenKid(0, 'short')).toThrow();
    expect(signerOfTokenKid(`uts-token-16-${THUMBPRINT}`)).toBeNull();
    expect(signerOfTokenKid(`uts-feed-00-${THUMBPRINT}`)).toBeNull();
    expect(UtsTokenKidSchema.safeParse(`uts-token-16-${THUMBPRINT}`).success).toBe(false);
  });
});

describe('UtsJwksSchema', () => {
  it('accepts Ed25519 public keys and rejects private parts, other key types and duplicate kids', () => {
    expect(UtsJwksSchema.parse({ keys: [jwk(0), jwk(1)] }).keys).toHaveLength(2);
    expect(UtsJwksSchema.safeParse({ keys: [{ ...jwk(0), d: THUMBPRINT }] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [{ ...jwk(0), crv: 'X25519' }] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [jwk(0), jwk(0)] }).success).toBe(false);
    expect(UtsJwksSchema.safeParse({ keys: [] }).success).toBe(false);
  });

  it('is a key set jose verifies an EdDSA at+jwt against', async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const exported = await exportJWK(pair.publicKey);
    const x = String(exported.x);
    const kid = tokenKid(4, await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x }));
    const jwks = UtsJwksSchema.parse({ keys: [{ ...jwk(4, x), kid }] });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: 'https://uts.kiloapps.io',
      aud: 'gateway',
      scope: 'gateway:models.read',
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .sign(pair.privateKey);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: 'https://uts.kiloapps.io',
      audience: 'gateway',
      typ: 'at+jwt',
      algorithms: ['EdDSA'],
    });
    expect(payload.scope).toBe('gateway:models.read');
  });
});

describe('SignerKeysAnswerSchema', () => {
  const READ_AT = 1_800_000_000_000;
  const signers = (): SignerKeysEntry[] =>
    Array.from({ length: 16 }, (_, signer) => ({
      signer,
      status: 'ok',
      keys: [jwk(signer)],
      readAt: READ_AT,
    }));

  it('accepts every signer exactly once, each with its keys and read time or a failure', () => {
    const answer = signers();
    answer[3] = { signer: 3, status: 'misconfigured' };
    answer[7] = { signer: 7, status: 'unavailable' };
    expect(SignerKeysAnswerSchema.parse({ signers: answer }).signers[7]).toEqual({
      signer: 7,
      status: 'unavailable',
    });
    const failing = Array.from({ length: 16 }, (_, signer) => ({ signer, status: 'unavailable' }));
    expect(SignerKeysAnswerSchema.safeParse({ signers: failing }).success).toBe(true);
    const withoutReadTime = Array.from({ length: 16 }, (_, signer) => ({
      signer,
      status: 'ok',
      keys: [jwk(signer)],
    }));
    expect(SignerKeysAnswerSchema.safeParse({ signers: withoutReadTime }).success).toBe(false);
  });

  it('names the signer-keys entrypoint, holds keys 24 hours, and reads an answer, a refusal or a misconfigured shard', () => {
    expect(UTS_SIGNER_KEYS_ENTRYPOINT).toBe('SignerKeys');
    expect(UTS_SIGNER_KEYS_HOLD_MS).toBe(24 * 60 * 60 * 1000);
    const answer = { signers: signers() };
    expect(SignerKeysReadSchema.parse({ status: 'answered', answer })).toEqual({
      status: 'answered',
      answer,
    });
    expect(SignerKeysReadSchema.parse({ status: 'refused' })).toEqual({ status: 'refused' });
    expect(SignerKeysReadSchema.parse({ status: 'misconfigured' })).toEqual({
      status: 'misconfigured',
    });
    expect(SignerKeysReadSchema.safeParse({ status: 'answered' }).success).toBe(false);
    expect(
      SignerKeysReadSchema.safeParse({ status: 'answered', answer: { signers: [] } }).success
    ).toBe(false);
  });

  it('rejects a missing or repeated signer, a kid of another signer, and a kid twice', () => {
    expect(SignerKeysAnswerSchema.safeParse({ signers: signers().slice(1) }).success).toBe(false);
    const repeated = signers();
    repeated[1] = { signer: 0, status: 'unavailable' };
    expect(SignerKeysAnswerSchema.safeParse({ signers: repeated }).success).toBe(false);
    const foreignKid = signers();
    foreignKid[2] = { signer: 2, status: 'ok', keys: [jwk(3)], readAt: READ_AT };
    expect(SignerKeysAnswerSchema.safeParse({ signers: foreignKid }).success).toBe(false);
    const twice = signers();
    twice[5] = { signer: 5, status: 'ok', keys: [jwk(5), jwk(5)], readAt: READ_AT };
    expect(SignerKeysAnswerSchema.safeParse({ signers: twice }).success).toBe(false);
  });
});

describe('AuthorizationServerMetadataSchema', () => {
  it('requires the issuer, key set, and flow lists, and keeps members it does not model', () => {
    const document = {
      issuer: 'https://uts.kiloapps.io',
      jwks_uri: 'https://uts-feed.kiloapps.io/.well-known/jwks.json',
      response_types_supported: [],
      grant_types_supported: [],
      token_endpoint: 'https://uts.kiloapps.io/token',
    };
    expect(AuthorizationServerMetadataSchema.parse(document)).toEqual(document);
    expect(
      AuthorizationServerMetadataSchema.safeParse({ ...document, jwks_uri: undefined }).success
    ).toBe(false);
    expect(
      AuthorizationServerMetadataSchema.safeParse({ ...document, grant_types_supported: undefined })
        .success
    ).toBe(false);
  });
});
