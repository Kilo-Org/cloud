jest.mock('./store', () => ({ getClaudeBillingConnection: jest.fn() }));
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
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getClaudeBillingConnection } from './store';
import { getClaudeOperatorToken, isClaudeOperatorConfigured } from './operator';
import { checkClaudeBilling } from './routing';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

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
  created_by: 'user',
};

beforeEach(() => {
  jest.mocked(getClaudeBillingConnection).mockReset().mockResolvedValue(row);
  jest.mocked(getClaudeOperatorToken).mockReset().mockResolvedValue('operator-token');
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
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
  };
}

describe('Claude customer-billed routing', () => {
  it.each(['messages', 'chat_completions'] as const)(
    'bills the profile over %s without a Kilo charge',
    async kind => {
      const args = input(kind);
      const result = await checkClaudeBilling(args);
      if (result?.kind !== 'provider') throw new Error('Expected customer-billed provider');
      expect(result.provider.apiUrl).toBe('https://api.anthropic.com/v1');
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
      expect(jest.mocked(getClaudeBillingConnection).mock.invocationCallOrder[0]).toBeLessThan(
        jest.mocked(isClaudePlatformOAuthEnabled).mock.invocationCallOrder[0] ?? 0
      );
    }
  );

  it('preserves normal routing for an owner without a connection when the flag is off', async () => {
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    jest.mocked(getClaudeBillingConnection).mockResolvedValue(null);
    expect(await checkClaudeBilling(input())).toBeNull();
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
    expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
  });

  it('does not serve an organization request from a personal connection', async () => {
    jest.mocked(getClaudeBillingConnection).mockResolvedValue(null);
    expect(await checkClaudeBilling({ ...input(), organizationId: 'organization' })).toBeNull();
    expect(getClaudeBillingConnection).toHaveBeenCalledWith(
      { kind: 'organization', organizationId: 'organization' },
      expect.anything()
    );
  });

  it.each([true, false])(
    'gates the requester of an organization connection (%s)',
    async enabled => {
      jest
        .mocked(isClaudePlatformOAuthEnabled)
        .mockImplementation(async email => enabled && email === 'requester@kilocode.ai');
      const result = await checkClaudeBilling({ ...input(), organizationId: 'organization' });
      expect(result?.kind).toBe(enabled ? 'provider' : 'unavailable');
      expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('requester@kilocode.ai');
      expect(getClaudeBillingConnection).toHaveBeenCalledWith(
        { kind: 'organization', organizationId: 'organization' },
        expect.anything()
      );
      if (!enabled) expect(getClaudeOperatorToken).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'organization'])(
    'refuses a connected payer when the authenticated requester email is absent (org=%s)',
    async organizationId => {
      expect(
        await checkClaudeBilling({ ...input(), organizationId, requesterEmail: null })
      ).toMatchObject({ kind: 'unavailable' });
      expect(getClaudeBillingConnection).toHaveBeenCalled();
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
    jest.mocked(getClaudeBillingConnection).mockResolvedValue({ ...row, status });
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
      .mocked(getClaudeBillingConnection)
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
      .mocked(getClaudeBillingConnection)
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
    expect(getClaudeBillingConnection).not.toHaveBeenCalled();
  });
});
