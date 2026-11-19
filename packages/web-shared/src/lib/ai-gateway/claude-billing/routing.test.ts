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
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getGrantedClaudeBillingConnection } from './store';
import { getClaudeOperatorToken, isClaudeOperatorConfigured } from './operator';
import { buildClaudeBillingProvider, checkClaudeBilling } from './routing';
import { ClaudeBillingPayerStateParseError } from './payer-state';
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

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

const ORGANIZATION_ROW: ClaudeBillingConnectionRow = {
  ...row,
  kilo_user_id: null,
  organization_id: ORGANIZATION_ID,
  user_profile_id: 'uprof_org',
  created_by: 'connector',
};

beforeEach(() => {
  jest.mocked(getGrantedClaudeBillingConnection).mockReset().mockResolvedValue(row);
  jest.mocked(getClaudeOperatorToken).mockReset().mockResolvedValue('operator-token');
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
  jest
    .mocked(findUserById)
    .mockReset()
    .mockResolvedValue({ id: 'connector', google_user_email: 'connector@kilocode.ai' } as never);
});

function request(kind: 'messages' | 'chat_completions' = 'messages'): GatewayRequest {
  return {
    kind,
    body: {
      model: 'anthropic/claude-sonnet-4.6',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

function input() {
  return {
    request: request(),
    requestedModel: '~anthropic/latest',
    userId: 'user',
    organizationId: undefined,
  };
}

/** The connection routing reads for an organization's requests. */
function organizationOwner() {
  return { kind: 'organization', organizationId: ORGANIZATION_ID } as const;
}

function organizationOnly() {
  jest
    .mocked(getGrantedClaudeBillingConnection)
    .mockImplementation(async owner => (owner.kind === 'organization' ? ORGANIZATION_ROW : null));
}

describe('Claude customer-billed routing', () => {
  it.each(
    ['anthropic/claude-fable-5.2', '~anthropic/claude-fable-latest'].flatMap(model =>
      (['adaptive', 'disabled', 'omitted'] as const).map(mode => ({ model, mode }))
    )
  )('handles $mode thinking for $model', async ({ model, mode }) => {
    const provider = buildClaudeBillingProvider(
      'operator-token',
      'claude-fable-5-2',
      { kind: 'personal', kiloUserId: 'user' },
      'uprof_test'
    );
    const gatewayRequest: GatewayRequest = {
      kind: 'messages',
      body: {
        model,
        max_tokens: 2_048,
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '', signature: 'FAKE_BILLING_TEST_SIGNATURE' },
              { type: 'redacted_thinking', data: 'FAKE_BILLING_TEST_REDACTED_DATA' },
              { type: 'text', text: 'Previous answer.' },
            ],
          },
        ],
        ...(mode === 'adaptive' && { thinking: { type: 'adaptive', display: 'summarized' } }),
        ...(mode === 'disabled' && { thinking: { type: 'disabled' } }),
      },
    };
    const headers: Record<string, string> = {
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'x-anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
    };

    const context = {
      provider,
      model,
      request: gatewayRequest,
      extraHeaders: headers,
      originalHeaders: {} as never,
      userByok: null,
      kilo_user_id: 'user',
      organization_id: null,
      session_id: null,
    };
    await provider.transformRequest(context);

    expect(context.model).toBe(model);
    expect(gatewayRequest.body).toMatchObject({
      model: 'claude-fable-5-2',
      thinking:
        mode === 'disabled'
          ? { type: 'disabled' }
          : {
              type: 'adaptive',
              ...(mode === 'adaptive' && { display: 'summarized' }),
              block_binding: { prefix_mismatch_behavior: 'drop_block' },
            },
      billing_policy: { type: 'billing_policy', bill_to: 'user_profile' },
    });
    expect(gatewayRequest.body.messages[1]).toMatchObject({
      role: 'assistant',
      content:
        mode === 'disabled'
          ? [{ type: 'text', text: 'Previous answer.' }]
          : [{ type: 'thinking' }, { type: 'redacted_thinking' }, { type: 'text' }],
    });
    for (const header of ['anthropic-beta', 'x-anthropic-beta']) {
      expect(headers[header].split(',')).toEqual(
        expect.arrayContaining([
          'fine-grained-tool-streaming-2025-05-14',
          'oauth-2025-04-20',
          'user-profiles-billing-2026-10-01',
          'thinking-binding-controls-2026-08-01',
        ])
      );
    }
  });

  it('bills the profile over the Messages API without a Kilo charge', async () => {
    const args = input();
    const result = await checkClaudeBilling(args);
    if (result?.kind !== 'provider') throw new Error('Expected customer-billed provider');
    expect(result.provider).toMatchObject({
      type: 'claude-billing',
      inferenceProviderId: 'anthropic',
      apiUrl: 'https://api.anthropic.com/v1',
      supportedChatApis: ['messages'],
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
  });

  it('does not serve an organization request from a personal connection', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner => (owner.kind === 'personal' ? row : null));
    expect(await checkClaudeBilling({ ...input(), organizationId: ORGANIZATION_ID })).toBeNull();
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledTimes(1);
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(
      organizationOwner(),
      expect.anything()
    );
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('bills the organization connection whatever the requester', async () => {
    organizationOnly();
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: ORGANIZATION_ID,
    });
    expect(result?.kind).toBe('provider');
    if (result?.kind !== 'provider') throw new Error('Expected organization provider');
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(
      organizationOwner(),
      expect.anything()
    );
    expect(result.provider.claudeBillingUserProfileId).toBe('uprof_org');
    expect(result.provider.claudeBillingOwner).toEqual(organizationOwner());
  });

  it('checks the organization connection connector before serving it', async () => {
    organizationOnly();
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: ORGANIZATION_ID,
    });
    expect(result?.kind).toBe('provider');
    expect(findUserById).toHaveBeenCalledWith('connector', expect.anything());
  });

  it.each([
    [
      'a soft-deleted account',
      {
        id: 'connector',
        google_user_email: 'deleted+c@deleted.invalid',
        blocked_reason: 'soft-deleted at 2026-01-01T00:00:00.000Z',
      },
    ],
    [
      'an account being deleted',
      {
        id: 'connector',
        google_user_email: 'connector@kilocode.ai',
        blocked_reason: 'deletion-in-progress at 2026-01-01T00:00:00.000Z',
      },
    ],
    ['an account with no email', { id: 'connector', google_user_email: '', blocked_reason: null }],
    ['a missing account', undefined],
  ])(
    'requires a reconnect for the organization connection when the connector is %s',
    async (_, user) => {
      organizationOnly();
      jest.mocked(findUserById).mockResolvedValue(user as never);

      const result = await checkClaudeBilling({
        ...input(),
        organizationId: ORGANIZATION_ID,
      });

      expect(result).toEqual({
        kind: 'reconnect',
        message: expect.stringContaining('is no longer available'),
      });
      expect(getGrantedClaudeBillingConnection).toHaveBeenCalledTimes(1);
      expect(getClaudeOperatorToken).not.toHaveBeenCalled();
    }
  );

  it('keeps serving an organization connection that records no connector', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner =>
        owner.kind === 'organization' ? { ...ORGANIZATION_ROW, created_by: null as never } : null
      );

    expect(await checkClaudeBilling({ ...input(), organizationId: ORGANIZATION_ID })).toMatchObject(
      { kind: 'provider' }
    );
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('serves a personal connection even when the recorded connector is gone', async () => {
    jest.mocked(findUserById).mockResolvedValue({
      id: 'connector',
      blocked_reason: 'soft-deleted at 2026-01-01',
    } as never);
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(row);

    const result = await checkClaudeBilling(input());

    expect(result?.kind).toBe('provider');
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('never falls back to another payer when the organization connection cannot bill', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockImplementation(async owner =>
        owner.kind === 'organization' ? { ...ORGANIZATION_ROW, status: 'billing_unavailable' } : row
      );
    const result = await checkClaudeBilling({
      ...input(),
      organizationId: ORGANIZATION_ID,
    });
    expect(result).toMatchObject({ kind: 'unavailable' });
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledTimes(1);
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('does not authorize an organization request without an authenticated requester', async () => {
    expect(
      await checkClaudeBilling({
        ...input(),
        userId: null,
        organizationId: 'organization',
      })
    ).toMatchObject({ kind: 'unavailable' });
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

  it('does not mark a payer reply that violates its contract as retryable', async () => {
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockRejectedValueOnce(new ClaudeBillingPayerStateParseError());
    expect(await checkClaudeBilling(input())).toEqual({
      kind: 'unavailable',
      message:
        'Your Claude link cannot be checked right now. This usually clears after a short wait, and an owner or admin can check the link at any time.',
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

  it.each<[string, GatewayRequest]>([
    [
      'Responses',
      { kind: 'responses', body: { model: 'anthropic/claude-sonnet-4.6', input: 'hello' } },
    ],
    ['Chat Completions', request('chat_completions')],
  ])('does not switch payer for the %s API', async (_name, gatewayRequest) => {
    expect(await checkClaudeBilling({ ...input(), request: gatewayRequest })).toMatchObject({
      kind: 'unavailable',
      message: 'Use the Messages API with your Claude link.',
    });
    expect(getClaudeOperatorToken).not.toHaveBeenCalled();
  });

  it('keeps unrelated models on their existing route', async () => {
    expect(await checkClaudeBilling({ ...input(), requestedModel: 'openai/gpt-model' })).toBeNull();
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
  });
});
