import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { createRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { TokenMintingService } from './token-minting-service.js';

const { findUserForToken, organizationExists, ensureBotUserForOrg, isDirectOrgMember } = vi.hoisted(
  () => ({
    findUserForToken: vi.fn(),
    organizationExists: vi.fn(),
    ensureBotUserForOrg: vi.fn(),
    isDirectOrgMember: vi.fn(),
  })
);

vi.mock('../db/queries.js', () => ({
  getWorkerDb: vi.fn(() => ({})),
  findUserForToken,
  organizationExists,
  ensureBotUserForOrg,
  isDirectOrgMember,
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
    organizationExists.mockReset();
    ensureBotUserForOrg.mockReset();
    isDirectOrgMember.mockReset();
    isDirectOrgMember.mockResolvedValue(true);
    findUserForToken.mockResolvedValue({
      id: 'user-1',
      api_token_pepper: 'current-pepper',
      blocked_at: null,
      blocked_reason: null,
    });
    organizationExists.mockResolvedValue(true);
    ensureBotUserForOrg.mockResolvedValue({
      id: 'webhook-bot-org-1',
      api_token_pepper: 'bot-pepper',
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
    expect(claims).not.toHaveProperty('organizationId');
  });

  it('includes the triggering organization in modern bot control assertions', async () => {
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = await service(true).mintToken({ orgId: organizationId, triggerId: 'trigger-1' });
    const claims = decodeJwt(result.token);

    expect(claims).toMatchObject({
      kiloUserId: 'webhook-bot-org-1',
      organizationId,
    });
    expect(claims).not.toMatchObject({
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
  });

  it('preserves the legacy bot token shape when modern assertions are disabled', async () => {
    const result = await service(false).mintToken({ orgId: 'org-1', triggerId: 'trigger-1' });
    const claims = decodeJwt(result.token);

    expect(claims).not.toHaveProperty('aud');
    expect(claims).not.toHaveProperty('organizationId');
  });

  it.each([undefined, false, true])(
    'always mints modern creator assertions with org billing and no bot for flag %s',
    async enabled => {
      const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      findUserForToken.mockResolvedValue({
        id: 'oauth/creator',
        api_token_pepper: 'creator-pepper',
        blocked_at: null,
        blocked_reason: null,
      });
      const result = await service(enabled).mintToken({
        orgId: organizationId,
        executionUserId: 'oauth/creator',
        triggerId: 'trigger-1',
      });

      expect(result).toMatchObject({ userId: 'oauth/creator', isBot: false });
      expect(decodeJwt(result.token)).toMatchObject({
        kiloUserId: 'oauth/creator',
        organizationId,
        apiTokenPepper: 'creator-pepper',
        aud: 'cloud-agent-next',
        runtimeAdmission: {
          source: 'automation',
          authorizationUserId: 'oauth/creator',
          authorizationPepper: 'creator-pepper',
        },
      });
      expect(decodeJwt(result.token)).not.toHaveProperty('botId');
      expect(isDirectOrgMember).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        'oauth/creator'
      );
      expect(ensureBotUserForOrg).not.toHaveBeenCalled();
    }
  );

  it('revalidates direct membership before every creator token mint without bot fallback', async () => {
    const mintingService = service(true);
    const input = {
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      executionUserId: 'user-1',
      triggerId: 'trigger-1',
    };
    await mintingService.mintToken(input);
    isDirectOrgMember.mockResolvedValue(false);

    await expect(mintingService.mintToken(input)).rejects.toThrow(
      'no longer a direct organization member'
    );
    expect(isDirectOrgMember).toHaveBeenCalledTimes(2);
    expect(organizationExists).toHaveBeenCalledTimes(2);
    expect(findUserForToken).toHaveBeenCalledTimes(2);
    expect(ensureBotUserForOrg).not.toHaveBeenCalled();
  });

  it.each([
    { blocked_at: '2026-10-21T00:00:00Z', blocked_reason: null },
    { blocked_at: null, blocked_reason: 'account deleted' },
  ])('rejects blocked or soft-deleted creators', async disabled => {
    findUserForToken.mockResolvedValue({ id: 'user-1', api_token_pepper: 'pepper', ...disabled });
    await expect(
      service(true).mintToken({ orgId: 'org-1', executionUserId: 'user-1', triggerId: 'trigger-1' })
    ).rejects.toThrow('blocked or deleted');
    expect(ensureBotUserForOrg).not.toHaveBeenCalled();
  });

  it('rejects a missing creator or inactive organization without bot fallback', async () => {
    const input = { orgId: 'org-1', executionUserId: 'user-1', triggerId: 'trigger-1' };
    findUserForToken.mockResolvedValue(null);
    await expect(service().mintToken(input)).rejects.toThrow('user not found');
    organizationExists.mockResolvedValue(false);
    await expect(service().mintToken(input)).rejects.toThrow('organization not found or deleted');
    expect(ensureBotUserForOrg).not.toHaveBeenCalled();
  });

  it('rejects creator identity on a personal trigger', async () => {
    await expect(
      service().mintToken({ userId: 'user-1', executionUserId: 'user-1', triggerId: 'trigger-1' })
    ).rejects.toThrow('requires an organization trigger');
    expect(findUserForToken).not.toHaveBeenCalled();
    expect(ensureBotUserForOrg).not.toHaveBeenCalled();
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

  it.each([
    { blocked_at: new Date(), blocked_reason: null },
    { blocked_at: null, blocked_reason: 'disabled' },
  ])('rejects disabled organization bot users', async disabled => {
    ensureBotUserForOrg.mockResolvedValue({
      id: 'webhook-bot-org-1',
      api_token_pepper: 'bot-pepper',
      ...disabled,
    });

    await expect(
      service(true).mintToken({ orgId: 'org-1', triggerId: 'trigger-1' })
    ).rejects.toThrow('Webhook bot user is blocked');
  });
});

describe('null-pepper personal webhook compatibility', () => {
  it.each([false, true])('preserves null pepper with shared resource tokens %s', async enabled => {
    findUserForToken.mockResolvedValue({
      id: 'oauth/personal',
      api_token_pepper: null,
      blocked_at: null,
      blocked_reason: null,
    });
    const { token } = await service(enabled).mintToken({
      userId: 'oauth/personal',
      triggerId: 'trigger-1',
    });
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: secret,
        connectionString: 'unused',
        resourceAudience: { audience: 'cloud-agent-next', mode: 'allow-legacy' },
        getUserPepper: async () => ({ pepper: null, blockedReason: null }),
      })
    ).resolves.toEqual({ userId: 'oauth/personal' });
    expect(decodeJwt(token).apiTokenPepper).toBeNull();
    if (enabled) {
      const runtime = await createRuntimeAuthorization({
        token,
        secret,
        connectionString: 'unused',
        resourceKind: 'cloud-agent-next',
        resourceId: 'session-1',
        adapters: {
          getPrincipal: async () => ({
            id: 'oauth/personal',
            apiTokenPepper: null,
            blockedAt: null,
            blockedReason: null,
            isBot: false,
          }),
        },
      });
      expect(decodeJwt(runtime.token)).toMatchObject({
        apiTokenPepper: null,
        aud: ['kilo-api', 'kilo-gateway', 'session-ingest'],
        tokenPurpose: 'delegated-workload',
      });
    }
  });
});
