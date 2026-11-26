import { describe, expect, it } from 'vitest';
import { SignableClaimsSchema, type SignableClaims } from '../../src/keys/claims';

function claims(overrides: Partial<SignableClaims> = {}): SignableClaims {
  return {
    iss: 'https://uts.kiloapps.io',
    exp: 1_800_000_600,
    aud: 'gateway',
    sub: 'user-1',
    client_id: 'kilo-cli',
    iat: 1_800_000_000,
    jti: 'jti-1',
    scope: 'gateway:models.read',
    env: 'production',
    ...overrides,
  };
}

const accepts = (input: unknown) => SignableClaimsSchema.safeParse(input).success;

describe('SignableClaimsSchema', () => {
  it('accepts the RFC 9068 claims with the Kilo claims and a nested actor chain', () => {
    const parsed = SignableClaimsSchema.parse(
      claims({
        org: 'org-1',
        req: 'cloud-agent',
        sid: 'grant-1',
        auth_time: 1_799_999_000,
        amr: ['passkey'],
        act: { sub: 'service:a', client_id: 'a', act: { sub: 'service:b' } },
      })
    );
    expect(parsed.act).toEqual({ sub: 'service:a', client_id: 'a', act: { sub: 'service:b' } });
  });

  it('refuses a second audience, a scope list, a scope of another audience and an unknown claim', () => {
    expect(accepts({ ...claims(), aud: ['gateway', 'mcp'] })).toBe(false);
    expect(accepts(claims({ scope: 'gateway:models.read gateway:models.write' }))).toBe(false);
    expect(accepts(claims({ scope: 'mcp:tools.call' }))).toBe(false);
    expect(accepts({ ...claims(), extra: 1 })).toBe(false);
    expect(accepts({ ...claims(), act: { sub: 'service:a', extra: 1 } })).toBe(false);
  });

  it('refuses a lifetime over 1 hour and an exp not after iat', () => {
    expect(accepts(claims({ exp: 1_800_003_600 }))).toBe(true);
    expect(accepts(claims({ exp: 1_800_003_601 }))).toBe(false);
    expect(accepts(claims({ exp: 1_800_000_000 }))).toBe(false);
  });
});
