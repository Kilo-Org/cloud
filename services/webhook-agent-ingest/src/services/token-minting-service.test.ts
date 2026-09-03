import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenMintingService } from './token-minting-service.js';

const { findUserForToken } = vi.hoisted(() => ({ findUserForToken: vi.fn() }));

vi.mock('../db/queries.js', () => ({
  getWorkerDb: vi.fn(() => ({})),
  findUserForToken,
  organizationExists: vi.fn(),
  ensureBotUserForOrg: vi.fn(),
}));

const secret = 'test-secret-at-least-thirty-two-characters';

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT payload missing');
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

function service(sharedResourceTokensEnabled?: string | boolean) {
  return new TokenMintingService({
    HYPERDRIVE: { connectionString: 'postgres://test' },
    NEXTAUTH_SECRET: { get: async () => secret },
    ENVIRONMENT: 'production',
    SHARED_RESOURCE_TOKENS_ENABLED: sharedResourceTokensEnabled,
  });
}

describe('webhook token minting', () => {
  beforeEach(() => {
    findUserForToken.mockReset();
    findUserForToken.mockResolvedValue({
      id: 'user-1',
      api_token_pepper: 'current-pepper',
      blocked_at: null,
      blocked_reason: null,
    });
  });

  it('uses the legacy format by default', async () => {
    const result = await service().mintToken({ userId: 'user-1', triggerId: 'trigger-1' });
    const claims = decodeJwt(result.token);

    expect(claims).toMatchObject({
      kiloUserId: 'user-1',
      apiTokenPepper: 'current-pepper',
      env: 'production',
      internalApiUse: true,
      createdOnPlatform: 'webhook',
    });
    expect(claims).not.toHaveProperty('aud');
  });

  it('uses a current-user modern cloud-agent control assertion when enabled', async () => {
    const result = await service(true).mintToken({ userId: 'user-1', triggerId: 'trigger-1' });
    const claims = decodeJwt(result.token);

    expect(claims).toMatchObject({
      aud: 'cloud-agent-next',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      apiTokenPepper: 'current-pepper',
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: 'user-1',
        authorizationPepper: 'current-pepper',
      },
    });
  });

  it.each([
    { blocked_at: new Date(), blocked_reason: null },
    { blocked_at: null, blocked_reason: 'disabled' },
  ])('rejects disabled personal users', async disabled => {
    findUserForToken.mockResolvedValue({
      id: 'user-1',
      api_token_pepper: 'current-pepper',
      ...disabled,
    });

    await expect(
      service(true).mintToken({ userId: 'user-1', triggerId: 'trigger-1' })
    ).rejects.toThrow('User is blocked');
  });
});
