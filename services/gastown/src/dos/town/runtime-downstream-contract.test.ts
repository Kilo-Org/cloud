import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import {
  signModernKiloToken,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import {
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
  type RuntimeAuthorizationAdapters,
} from '@kilocode/worker-utils/runtime-authorization';

const secret = 'gastown-downstream-contract-test-secret';

async function fixture(organizationId?: string) {
  let pepper = 'initial-pepper';
  const adapters: RuntimeAuthorizationAdapters = {
    getPrincipal: async () => ({
      id: 'oauth/town-owner',
      apiTokenPepper: pepper,
      blockedAt: null,
      blockedReason: null,
      isBot: false,
    }),
    getMembership: async () => ({
      id: 'current-membership',
      role: 'owner',
      organizationDeletedAt: null,
    }),
  };
  const control = await signModernKiloToken({
    userId: 'oauth/town-owner',
    pepper,
    secret,
    expiresInSeconds: 55 * 60,
    audience: 'gastown',
    tokenPurpose: 'human-api',
    credentialExchange: false,
    extra: {
      organizationId,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: 'oauth/town-owner',
        authorizationPepper: pepper,
      },
    },
  });
  const input = {
    token: control.token,
    secret,
    connectionString: 'postgres://unused',
    resourceKind: 'gastown' as const,
    resourceId: 'town-1',
    organizationId,
    adapters,
  };
  return { input, rotatePepper: () => (pepper = 'rotated-pepper') };
}

describe('Gastown signed runtime downstream contract', () => {
  it('admits the control token only at Gastown, and runtime at API and gateway receivers', async () => {
    const { input } = await fixture();
    await expect(
      verifyKiloTokenForPolicy(input.token, secret, { audience: 'gastown', mode: 'allow-legacy' })
    ).resolves.toBeDefined();
    const runtime = await createRuntimeAuthorization(input);
    for (const audience of ['kilo-api', 'kilo-gateway']) {
      await expect(
        verifyKiloTokenForPolicy(runtime.token, secret, { audience, mode: 'allow-legacy' })
      ).resolves.toBeDefined();
      await expect(
        verifyKiloTokenForPolicy(input.token, secret, { audience, mode: 'allow-legacy' })
      ).rejects.toThrow();
    }
    for (const audience of ['gastown', 'wasteland']) {
      await expect(
        verifyKiloTokenForPolicy(runtime.token, secret, { audience, mode: 'allow-legacy' })
      ).rejects.toThrow();
    }
  });

  it('records the activation blocker: the CLI session-ingest reader rejects Gastown runtime tokens', async () => {
    const { input } = await fixture();
    const runtime = await createRuntimeAuthorization(input);
    await expect(
      verifyKiloTokenForPolicy(runtime.token, secret, {
        audience: 'session-ingest',
        mode: 'allow-legacy',
      })
    ).rejects.toThrow();
  });

  it('records the activation blocker: unscoped browser control cannot admit an org town', async () => {
    const { input } = await fixture();
    await expect(createRuntimeAuthorization({ ...input, organizationId: 'org-1' })).rejects.toThrow(
      'Invalid runtime admission'
    );
    const scoped = await fixture('org-1');
    await expect(createRuntimeAuthorization(scoped.input)).resolves.toBeDefined();
  });

  it('does not renew after pepper rotation', async () => {
    const { input, rotatePepper } = await fixture();
    const runtime = await createRuntimeAuthorization(input);
    rotatePepper();
    await expect(
      renewRuntimeAuthorization({ ...input, authorization: runtime.authorization })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });

  it('caps bearer lifetime at one hour and at the fixed delegation deadline', async () => {
    const { input } = await fixture();
    const runtime = await createRuntimeAuthorization(input);
    const claims = decodeJwt(runtime.token);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60 * 60);
    const deadline = Date.parse(runtime.authorization.delegationExpiresAt);
    const renewed = await renewRuntimeAuthorization({
      ...input,
      authorization: runtime.authorization,
      now: new Date(deadline - 30_000),
    });
    const renewedClaims = decodeJwt(renewed.token);
    expect(Number(renewedClaims.exp) - Number(renewedClaims.iat)).toBe(30);
    await expect(
      renewRuntimeAuthorization({
        ...input,
        authorization: runtime.authorization,
        now: new Date(deadline),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationExpiredError);
  });
});
