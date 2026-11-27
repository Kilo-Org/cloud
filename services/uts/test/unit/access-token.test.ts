import { TokenResponseSchema, UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import type { UtsConfig } from '../../src/env';
import type { Minted } from '../../src/grants/store';
import { SignableClaimsSchema } from '../../src/keys/claims';
import {
  accessTokenClaims,
  accessTokenLifetimeSeconds,
  tokenResponseBody,
} from '../../src/token/mint';

const config: UtsConfig = {
  environment: 'production',
  endpoints: UTS_ENDPOINTS.production,
  jurisdiction: 'eu',
  relyingParty: { rpId: 'app.kilo.ai', origins: ['https://uts.kiloapps.io'] },
  managerBaseUrl: null,
};
const NOW = 1_800_000_000;
const grantId = '6f1c1b8e-4b55-4c1a-9a43-0d3b1f7d2c10';

function minted(overrides: Partial<Minted> = {}): Minted {
  return {
    subjectId: 'oauth/user-1',
    orgId: null,
    orgRole: null,
    authTime: new Date((NOW - 3600) * 1000),
    amr: ['passkey'],
    tokenIds: [crypto.randomUUID(), crypto.randomUUID()],
    scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
    ...overrides,
  };
}

describe('access-token claims', () => {
  it('carry exactly the design 5.3 claims, one audience and one scope per token', () => {
    const input = minted();
    const claims = accessTokenClaims(config, 'kilo-cli', grantId, input, NOW);
    expect(claims).toEqual([
      {
        iss: 'https://uts.kiloapps.io',
        exp: NOW + 600,
        aud: 'gateway',
        sub: 'oauth/user-1',
        client_id: 'kilo-cli',
        iat: NOW,
        jti: input.tokenIds[0],
        scope: 'gateway:models.read',
        sid: grantId,
        auth_time: NOW - 3600,
        amr: ['passkey'],
        env: 'production',
      },
      expect.objectContaining({
        aud: 'kilo-chat',
        scope: 'kilo-chat:messages.read',
        jti: input.tokenIds[1],
      }),
    ]);
    for (const claimSet of claims) {
      expect(SignableClaimsSchema.safeParse(claimSet).success).toBe(true);
    }
  });

  it('name the bound organization in org and leave act and req out', () => {
    const orgId = '9b2f6c1e-1d2a-4c5b-8e7f-0a1b2c3d4e5f';
    const [claimSet] = accessTokenClaims(config, 'kilo-cli', grantId, minted({ orgId }), NOW);
    expect(claimSet.org).toBe(orgId);
    expect(claimSet).not.toHaveProperty('act');
    expect(claimSet).not.toHaveProperty('req');
  });

  it("live each scope's registered maximum: 5 minutes for a one-shot capability, else 10", () => {
    const scopes = [
      'user-data-export:exports.dispatch',
      'git-token-service:github-user-authorizations.disconnect',
      'git-token-service:bitbucket.repositories.read',
      'gateway:models.read',
    ];
    const claims = accessTokenClaims(
      config,
      'kilo-web',
      grantId,
      minted({ scopes, tokenIds: scopes.map(() => crypto.randomUUID()) }),
      NOW
    );
    expect(claims.map(claimSet => claimSet.exp - claimSet.iat)).toEqual([300, 300, 600, 600]);
    expect(scopes.map(accessTokenLifetimeSeconds)).toEqual([300, 300, 600, 600]);
    const body = TokenResponseSchema.parse(
      tokenResponseBody(
        claims,
        scopes.map((_, index) => `token-${index}`),
        null,
        NOW * 1000
      )
    );
    expect(body.expires_in).toBe(300);
    expect(body.issued_tokens.map(token => token.expires_in)).toEqual([300, 300, 600, 600]);
  });
});

describe('token response', () => {
  it('describes the first token in the RFC 6749 members and lists every token', () => {
    const claims = accessTokenClaims(config, 'kilo-cli', grantId, minted(), NOW);
    const body = tokenResponseBody(claims, ['token-a', 'token-b'], null, NOW * 1000);
    expect(TokenResponseSchema.parse(body)).toEqual({
      access_token: 'token-a',
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'gateway:models.read',
      issued_tokens: [
        {
          access_token: 'token-a',
          token_type: 'Bearer',
          expires_in: 600,
          audience: 'gateway',
          scope: 'gateway:models.read',
        },
        {
          access_token: 'token-b',
          token_type: 'Bearer',
          expires_in: 600,
          audience: 'kilo-chat',
          scope: 'kilo-chat:messages.read',
        },
      ],
    });
  });

  it('adds a new refresh token with its remaining idle seconds', () => {
    const claims = accessTokenClaims(
      config,
      'kilo-cli',
      grantId,
      minted({ tokenIds: [crypto.randomUUID()], scopes: ['gateway:models.read'] }),
      NOW
    );
    const body = tokenResponseBody(
      claims,
      ['token-a'],
      { token: 'refresh', expiresAt: new Date((NOW + 30 * 86_400) * 1000) },
      NOW * 1000
    );
    expect(TokenResponseSchema.parse(body)).toMatchObject({
      refresh_token: 'refresh',
      refresh_token_expires_in: 30 * 86_400,
    });
  });
});
