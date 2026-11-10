jest.mock('./store', () => ({ getGrantedClaudeBillingConnection: jest.fn() }));
jest.mock('./operator', () => ({
  getClaudeOperatorToken: jest.fn(),
  isClaudeOperatorConfigured: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  resolveOpenRouterModelAlias: jest.fn(async (model: string) =>
    model === '~anthropic/latest' ? 'anthropic/claude-sonnet-4.6' : model
  ),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getGrantedClaudeBillingConnection } from './store';
import { getClaudeOperatorToken, isClaudeOperatorConfigured } from './operator';
import { checkClaudeBilling } from './routing';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';

const row: ClaudeBillingConnectionRow = {
  id: 'row',
  kilo_user_id: 'user',
  organization_id: null,
  user_profile_id: 'uprof_test',
  connection_id: 'ocon_test',
  status: 'connected',
  connected_at: '2026-01-01T00:00:00Z',
  last_refusal_code: null,
  last_refusal_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'connector',
};

const SHARED_ORG_ID = '00000000-0000-4000-8000-000000000001';

const SHARED_ROW: ClaudeBillingConnectionRow = {
  ...row,
  kilo_user_id: null,
  organization_id: SHARED_ORG_ID,
  user_profile_id: 'uprof_shared',
  created_by: 'connector',
};

beforeEach(() => {
  jest.mocked(getGrantedClaudeBillingConnection).mockReset().mockResolvedValue(row);
  jest.mocked(getClaudeOperatorToken).mockReset().mockResolvedValue('operator-token');
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
  jest
    .mocked(findUserById)
    .mockReset()
    .mockResolvedValue({ id: 'connector', google_user_email: 'connector@kilocode.ai' } as never);
});

function request(kind: 'messages' | 'chat_completions'): GatewayRequest {
  return {
    kind,
    body: {
      model: 'anthropic/claude-sonnet-4.6',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

function input(kind: 'messages' | 'chat_completions' = 'messages') {
  return {
    request: request(kind),
    requestedModel: '~anthropic/latest',
    userId: 'user',
    requesterEmail: 'requester@kilocode.ai',
    organizationId: undefined,
    botId: undefined,
  };
}

/** The connection the routing read for the organization's shared services. */
function sharedOwner() {
  return { kind: 'shared_services', organizationId: SHARED_ORG_ID } as const;
}

describe('Claude customer-billed routing', () => {
  it.each(['messages', 'chat_completions'] as const)(
    'bills the profile over %s without a Kilo charge',
    async kind => {
      const args = input(kind);
      const result = await checkClaudeBilling(args);
      if (result?.kind !== 'provider') throw new Error('Expected customer-billed provider');
      expect(result.provider).toMatchObject({
        type: 'claude-billing',
        inferenceProviderId: 'anthropic',
        apiUrl: 'https://api.anthropic.com/v1',
      });
      const headers: Record<string, string> = {};
      await result.provider.transformRequest({
        provider: result.provider,
        model: args.requestedModel,
        request: args.request,
        extraHeaders: headers,
        originalHeaders: {} as never,
        userByok: null,
        kilo_user_id: 'user',
        organization_id: null,
        session_id: null,
      });
      expect(args.request.body).toMatchObject({
        model: 'claude-sonnet-4-6',
        billing_policy: { type: 'billing_policy', bill_to: 'user_profile' },
      });
      expect(headers['anthropic-user-profile-id']).toBe('uprof_test');
      expect(headers['anthropic-beta']).toContain('user-profiles-billing-2026-10-01');
      expect(result.skipBalanceCheck).toBe(true);
    }
  );

  it.each(['messages', 'chat_completions'] as const)(
    'pauses a connected owner without switching payer when the flag is off (%s)',
    async kind => {
      jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
      expect(await checkClaudeBilling(input(kind))).toMatchObject({
        kind: 'unavailable',
        message: expect.stringContaining('not enabled'),
      });
      expect(getClaudeOperatorToken).not.toHaveBeenCalled();
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('requester@kilocode.ai');
      expect(
        jest.mocked(getGrantedClaudeBillingConnection).mock.invocationCallOrder[0]
      ).toBeLessThan(jest.mocked(isClaudePlatformOAuthEnabled).mock.invocationCallOrder[0] ?? 0);
    }
  );

  it('preserves normal routing for an owner without a connection when the flag is off', async () => {
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(null);
    expect(await checkClaudeBilling(input())).toBeNull();
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
    expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
  });

  it('does not serve an organization request from a personal connection', async () => {
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(null);
    expect(await checkClaudeBilling({ ...input(), organizationId: 'organization' })).toBeNull();
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(
      { kind: 'member', kiloUserId: 'user', organizationId: 'organization' },
      expect.anything()
    );
  });

  it.each([true, false])('gates the requester of a member connection (%s)', async enabled => {
    jest
      .mocked(isClaudePlatformOAuthEnabled)
      .mockImplementation(async email => enabled && email === 'requester@kilocode.ai');
    const result = await checkClaudeBilling({ ...input(), organizationId: 'organization' });
    expect(result?.kind).toBe(enabled ? 'provider' : 'unavailable');
    expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('requester@kilocode.ai');
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(
      { kind: 'member', kiloUserId: 'user', organizationId: 'organization' },
      expect.anything()
    );
    if (!enabled) expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('serves a service run from the shared-services connection first', async () => {
    jest.mocked(getGrantedClaudeBillingConnection).mockImplementation(async owner => {
      if (owner.kind === 'shared_services') return SHARED_ROW;
      return null;
    });
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: SHARED_ORG_ID,
      botId: 'reviewer',
    });
    expect(result?.kind).toBe('provider');
    if (result?.kind !== 'provider') throw new Error('Expected shared-services provider');
    expect(getGrantedClaudeBillingConnection).toHaveBeenNthCalledWith(
      1,
      sharedOwner(),
      expect.anything()
    );
    expect(result.provider.claudeBillingUserProfileId).toBe('uprof_shared');
  });

  it('gates the shared-services connection on the person who connected it', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner => (owner.kind === 'shared_services' ? SHARED_ROW : null));
    const result = await checkClaudeBilling({
      ...input(),
      requesterEmail: 'code-review-bot@kilocode.local',
      organizationId: SHARED_ORG_ID,
      botId: 'reviewer',
    });
    expect(result?.kind).toBe('provider');
    expect(findUserById).toHaveBeenCalledWith('connector', expect.anything());
    expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('connector@kilocode.ai');
  });

  it('fails a shared-services request whose connector is no longer eligible', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner => (owner.kind === 'shared_services' ? SHARED_ROW : null));
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    expect(
      await checkClaudeBilling({
        ...input(),
        organizationId: SHARED_ORG_ID,
        botId: 'reviewer',
      })
    ).toMatchObject({ kind: 'unavailable' });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('falls back to the caller connection when the organization has no shared one', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner =>
        owner.kind === 'member' ? { ...row, kilo_user_id: 'user' } : null
      );
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: SHARED_ORG_ID,
      botId: 'reviewer',
    });
    expect(result?.kind).toBe('provider');
    expect(getGrantedClaudeBillingConnection).toHaveBeenNthCalledWith(
      2,
      {
        kind: 'member',
        kiloUserId: 'user',
        organizationId: SHARED_ORG_ID,
      },
      expect.anything()
    );
  });

  it('never falls back to the member connection when the shared one cannot bill', async () => {
    jest.mocked(getGrantedClaudeBillingConnection).mockImplementation(async owner => {
      if (owner.kind === 'shared_services') return { ...SHARED_ROW, status: 'billing_unavailable' };
      return row;
    });
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: SHARED_ORG_ID,
      botId: 'reviewer',
    });
    expect(result).toMatchObject({ kind: 'unavailable' });
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledTimes(1);
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('ignores a bot id without an organization', async () => {
    const result = await checkClaudeBilling({ ...input(), botId: 'reviewer' });
    expect(result?.kind).toBe('provider');
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(
      { kind: 'personal', kiloUserId: 'user' },
      expect.anything()
    );
  });

  it.each([undefined, 'organization'])(
    'refuses a connected payer when the authenticated requester email is absent (org=%s)',
    async organizationId => {
      expect(
        await checkClaudeBilling({ ...input(), organizationId, requesterEmail: null })
      ).toMatchObject({ kind: 'unavailable' });
      expect(getGrantedClaudeBillingConnection).toHaveBeenCalled();
      expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
      expect(getClaudeOperatorToken).not.toHaveBeenCalled();
    }
  );

  it('does not authorize an organization request without an authenticated requester', async () => {
    expect(
      await checkClaudeBilling({
        ...input(),
        userId: null,
        organizationId: 'organization',
      })
    ).toMatchObject({ kind: 'unavailable' });
    expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it.each(['pending', 'removed'] as const)('keeps normal routing for %s owners', async status => {
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue({ ...row, status });
    expect(await checkClaudeBilling(input())).toBeNull();
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('never falls back when operator configuration is absent', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    expect(await checkClaudeBilling(input())).toMatchObject({ kind: 'unavailable' });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('keeps a failed payer lookup retryable without selecting another payer', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockRejectedValueOnce(new Error('database unavailable'));
    expect(await checkClaudeBilling(input())).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('accepts an undated Anthropic alias instead of rejecting it against a canonical model list', async () => {
    const args = input();
    args.requestedModel = 'anthropic/claude-haiku-4.5';
    args.request.body.model = args.requestedModel;
    const result = await checkClaudeBilling(args);
    if (result?.kind !== 'provider') throw new Error('Expected customer-billed provider');
    await result.provider.transformRequest({
      provider: result.provider,
      model: args.requestedModel,
      request: args.request,
      extraHeaders: {},
      originalHeaders: {} as never,
      userByok: null,
      kilo_user_id: 'user',
      organization_id: null,
      session_id: null,
    });
    expect(args.request.body.model).toBe('claude-haiku-4-5');
  });

  it('fails locally without fetching an operator token after a terminal refusal', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockResolvedValue({ ...row, status: 'billing_unavailable' });
    expect(await checkClaudeBilling(input())).toMatchObject({ kind: 'unavailable' });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('does not switch payer for an unsupported API shape', async () => {
    expect(
      await checkClaudeBilling({
        ...input(),
        request: {
          kind: 'responses',
          body: { model: 'anthropic/claude-sonnet-4.6', input: 'hello' },
        },
      })
    ).toMatchObject({ kind: 'unavailable' });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('keeps unrelated models on their existing route', async () => {
    expect(await checkClaudeBilling({ ...input(), requestedModel: 'openai/gpt-model' })).toBeNull();
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
  });
});
