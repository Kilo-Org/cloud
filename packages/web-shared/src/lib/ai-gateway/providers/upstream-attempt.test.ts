jest.mock('./upstream-request', () => ({
  upstreamRequest: jest.fn(),
}));
jest.mock('./apply-provider-specific-logic', () => ({
  applyProviderSpecificLogic: jest.fn(),
}));
jest.mock('./gateway-models-cache', () => ({
  ...jest.requireActual('./gateway-models-cache'),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
  getOpenRouterModelsFromDatabase: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(async () => new Set(['alibaba/qwen3.5-flash'])),
  isValidOpenRouterModelId: jest.fn(),
}));
jest.mock('./openrouter', () => ({
  ...jest.requireActual('./openrouter'),
  getRawOpenRouterModels: jest.fn(),
}));
jest.mock('./preferred-provider-order-config', () => ({
  getPreferredProviderOrderConfig: jest.fn(),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import type { StoredModel } from '@kilocode/db';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/eligibility';
import { OPENAI_ON_BEHALF_OF_TOKEN_HEADER } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import {
  getOpenAiChatGptStoredConnection,
  readOpenAiChatGptUsageLimit,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { applyProviderSpecificLogic } from './apply-provider-specific-logic';
import {
  getOpenRouterModelsFromDatabase,
  getOpenRouterModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from './gateway-models-cache';
import { getRawOpenRouterModels } from './openrouter';
import { getPreferredProviderOrderConfig } from './preferred-provider-order-config';
import { upstreamRequest } from './upstream-request';
import { sendUpstreamAttempt } from './upstream-attempt';

const ACCESS_TOKEN = 'delegated-access-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
describe('bounded spending provider enforcement', () => {
  const model: StoredModel = {
    id: 'test/preferred',
    name: 'Preferred model',
    endpoints: [
      { tag: 'preferred-route', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      { tag: 'expensive-route', pricing: { prompt: '0.000002', completion: '0.000004' } },
    ],
  };
  const catalogEntry: OpenRouterModel = {
    id: model.id,
    name: model.name,
    created: 0,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0.0000001', completion: '0.0000002' },
    context_length: 128_000,
  };

  beforeEach(() => {
    jest.mocked(applyProviderSpecificLogic).mockResolvedValue(undefined);
    jest.mocked(upstreamRequest).mockClear();
    jest.mocked(isValidOpenRouterModelId).mockResolvedValue(true);
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({ [model.id]: model });
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set([model.id]));
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [catalogEntry] });
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({
      rules: [{ includes: ['test/'], providers: ['preferred-route'] }],
    });
  });

  function attempt(
    providerId: string,
    userByok: BYOKResult[] | null,
    availableBalanceMicrodollars = 2_000_000
  ) {
    jest.mocked(upstreamRequest).mockResolvedValue({
      type: 'success',
      response: jsonResponse(200, { ok: true }),
    } as never);
    return sendUpstreamAttempt({
      dataRegion: null,
      providerContext: { provider: { type: providerId }, userByok } as never,
      requestedModel: model.id,
      request: {
        kind: 'chat_completions',
        body: {
          model: model.id,
          messages: [{ role: 'user', content: 'Evidence' }],
          max_tokens: 64,
          stream: false,
          provider: { only: ['expensive-route'] },
        },
      } as never,
      fraudHeaders: {} as never,
      userId: 'test-user',
      organizationId: null,
      sessionId: null,
      taskId: null,
      isNonTrialEnterprise: false,
      search: '',
      method: 'POST',
      costLimit: { maximumMicrodollars: '500', availableBalanceMicrodollars },
    });
  }

  it('serves a connected customer without applying a Kilo debit limit to the external bill', async () => {
    jest
      .mocked(applyProviderSpecificLogic)
      .mockImplementationOnce(async (_provider, _model, request) => {
        Object.assign(request.body, {
          billing_policy: { type: 'billing_policy', bill_to: 'user_profile' },
        });
      });
    const result = await attempt('claude-billing', null, 0);
    expect(result.type).toBe('success');
    expect(upstreamRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses a managed Vercel route the quoted ceiling cannot cover', async () => {
    const result = await attempt('vercel', null);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.response.status).toBe(402);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Bounded spending requires a provider that can enforce it',
      });
    }
    expect(upstreamRequest).not.toHaveBeenCalled();
  });

  it('caps an OpenRouter attempt at the cheaper picker route price', async () => {
    const request = {
      kind: 'chat_completions' as const,
      body: {
        model: model.id,
        messages: [{ role: 'user', content: 'Evidence' }],
        max_tokens: 64,
        stream: false,
        provider: { only: ['expensive-route'] },
      },
    };
    jest.mocked(upstreamRequest).mockResolvedValue({
      type: 'success',
      response: jsonResponse(200, { ok: true }),
    } as never);

    const result = await sendUpstreamAttempt({
      dataRegion: null,
      providerContext: { provider: { type: 'openrouter' }, userByok: null } as never,
      requestedModel: model.id,
      request: request as never,
      fraudHeaders: {} as never,
      userId: 'test-user',
      organizationId: null,
      sessionId: null,
      taskId: null,
      isNonTrialEnterprise: false,
      search: '',
      method: 'POST',
      costLimit: { maximumMicrodollars: '500', availableBalanceMicrodollars: 2_000_000 },
    });

    expect(result.type).toBe('success');
    expect(request.body.provider).toEqual({
      only: ['expensive-route'],
      max_price: { prompt: 0.1, completion: 0.2, request: 0 },
    });
  });
});
describe('upstream model catalog validation', () => {
  type AttemptInput = Parameters<typeof sendUpstreamAttempt>[0];
  const canonicalModels = new Set([
    'qwen/qwen3-coder',
    'z-ai/glm-5',
    'mistralai/mistral-small',
    'x-ai/grok-4',
    'bytedance-seed/seed-2.0',
    'openai/gpt-4o',
    '~deepseek/deepseek-pro-latest',
  ]);

  beforeEach(() => {
    jest.mocked(isValidOpenRouterModelId).mockReset();
    jest
      .mocked(isValidOpenRouterModelId)
      .mockImplementation(async model => canonicalModels.has(model));
    jest.mocked(applyProviderSpecificLogic).mockReset();
    jest.mocked(upstreamRequest).mockReset();
    jest.mocked(upstreamRequest).mockResolvedValue({
      type: 'success',
      response: jsonResponse(200, { ok: true }),
    });
  });

  function attempt({
    providerId = 'vercel',
    requestedModel,
    wireModel,
    kind = 'chat_completions',
    userByok = null,
  }: {
    providerId?: AttemptInput['providerContext']['provider']['type'];
    requestedModel: string;
    wireModel: string;
    kind?: AttemptInput['request']['kind'];
    userByok?: BYOKResult[] | null;
  }) {
    const request: AttemptInput['request'] =
      kind === 'responses'
        ? { kind, body: { model: requestedModel, input: 'Evidence' } }
        : {
            kind,
            body: {
              model: requestedModel,
              messages: [{ role: 'user', content: 'Evidence' }],
              max_tokens: 64,
            },
          };
    jest
      .mocked(applyProviderSpecificLogic)
      .mockImplementation(async (_provider, _model, request) => {
        request.body.model = wireModel;
      });
    return sendUpstreamAttempt({
      dataRegion: null,
      providerContext: {
        provider: { type: providerId },
        userByok,
      } as AttemptInput['providerContext'],
      requestedModel,
      request,
      fraudHeaders: EmptyFraudDetectionHeaders,
      userId: 'test-user',
      organizationId: null,
      sessionId: null,
      taskId: null,
      isNonTrialEnterprise: false,
      search: '',
      method: 'POST',
    });
  }

  describe.each(['chat_completions', 'responses', 'messages'] as const)('%s', kind => {
    describe.each(['openrouter', 'vercel'] as const)('%s', providerId => {
      const byokProviderId = providerId === 'vercel' ? 'vercel-ai-gateway' : providerId;

      it.each([false, true])('blocks an invalid catalog ID (BYOK: %s)', async byok => {
        const result = await attempt({
          providerId,
          requestedModel: 'qwen/not-in-catalog',
          wireModel: 'openai/gpt-4o',
          kind,
          userByok: byok ? [{ providerId: byokProviderId, decryptedAPIKey: 'test-key' }] : null,
        });

        expect(result).toEqual({ type: 'invalid-openrouter-model' });
        expect(jest.mocked(isValidOpenRouterModelId).mock.calls).toEqual([['qwen/not-in-catalog']]);
        expect(upstreamRequest).not.toHaveBeenCalled();
      });

      it.each([false, true])('sends a valid catalog ID (BYOK: %s)', async byok => {
        const result = await attempt({
          providerId,
          requestedModel: 'qwen/qwen3-coder',
          wireModel: 'alibaba/qwen3-coder',
          kind,
          userByok: byok ? [{ providerId: byokProviderId, decryptedAPIKey: 'test-key' }] : null,
        });

        expect(result.type).toBe('success');
        expect(jest.mocked(isValidOpenRouterModelId).mock.calls).toEqual([['qwen/qwen3-coder']]);
        expect(upstreamRequest).toHaveBeenCalledTimes(1);
        expect(upstreamRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            chatApi: kind,
            body: expect.objectContaining({
              model: 'alibaba/qwen3-coder',
            }),
          })
        );
      });
    });
  });

  it.each([
    ['z-ai/glm-5', 'zai/glm-5'],
    ['mistralai/mistral-small', 'mistral/mistral-small'],
    ['x-ai/grok-4', 'spacexai/grok-4'],
    ['bytedance-seed/seed-2.0', 'bytedance/seed-2.0'],
    ['openai/gpt-4o', 'override/custom-deployment'],
    ['~deepseek/deepseek-pro-latest', 'deepseek/deepseek-v4-pro-0813'],
  ])('validates %s before sending Vercel wire ID %s', async (requestedModel, wireModel) => {
    const result = await attempt({ requestedModel, wireModel });

    expect(result.type).toBe('success');
    expect(jest.mocked(isValidOpenRouterModelId).mock.calls).toEqual([[requestedModel]]);
    expect(upstreamRequest).toHaveBeenCalledTimes(1);
    expect(upstreamRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ model: wireModel }) })
    );
  });

  it.each(['openrouter', 'vercel'] as const)(
    '%s skips catalog validation for the auto small free model',
    async providerId => {
      jest.mocked(isValidOpenRouterModelId).mockResolvedValue(false);
      const result = await attempt({
        providerId,
        requestedModel: AUTO_SMALL_TARGET_MODELS.free,
        wireModel: AUTO_SMALL_TARGET_MODELS.paid,
      });

      expect(result.type).toBe('success');
      expect(isValidOpenRouterModelId).not.toHaveBeenCalled();
      expect(upstreamRequest).toHaveBeenCalledTimes(1);
      expect(upstreamRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ model: AUTO_SMALL_TARGET_MODELS.paid }),
        })
      );
    }
  );

  it.each([
    ['vercel', 'success'],
    ['openrouter', 'invalid-openrouter-model'],
  ] as const)('accepts a Vercel-only model only on the %s route', async (providerId, type) => {
    jest.mocked(isValidOpenRouterModelId).mockResolvedValue(false);
    const result = await attempt({
      providerId,
      requestedModel: 'qwen/qwen3.5-flash',
      wireModel: 'alibaba/qwen3.5-flash',
    });

    expect(result.type).toBe(type);
  });

  it.each(['direct-byok', 'mistral', 'inception', 'custom', 'custom-public', 'dev-tools'] as const)(
    'does not validate %s models against the OpenRouter catalog',
    async providerId => {
      const result = await attempt({
        providerId,
        requestedModel: 'not-in-catalog',
        wireModel: 'provider-specific-model',
      });

      expect(result.type).toBe('success');
      expect(isValidOpenRouterModelId).not.toHaveBeenCalled();
      expect(upstreamRequest).toHaveBeenCalledTimes(1);
    }
  );
});
describe('sendUpstreamAttempt with a ChatGPT connection (real database)', () => {
  let owner: OpenAiChatGptOwner;

  beforeEach(async () => {
    const user = await insertTestUser({
      google_user_email: `upstream-attempt-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
    await saveOpenAiChatGptConnection(
      owner,
      {
        access_token: ACCESS_TOKEN,
        refresh_token: 'refresh',
        expires_at: 1_800_000_000,
        issuer: 'https://auth.openai.com',
        client_id: 'client-id',
        subject: 'subject',
        connected_at: '2026-10-05T00:00:00.000Z',
        status: 'connected',
      },
      user.id
    );
    // The real transform puts the delegated token in this header.
    jest
      .mocked(applyProviderSpecificLogic)
      .mockImplementation(async (_provider, _model, _request, extraHeaders) => {
        extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER] = ACCESS_TOKEN;
      });
  });

  async function send(response: Response) {
    jest.mocked(upstreamRequest).mockResolvedValue({ type: 'success', response } as never);
    return sendUpstreamAttempt({
      dataRegion: null,
      providerContext: {
        provider: { type: 'openai-chatgpt', chatGptOwner: owner },
        userByok: null,
      } as never,
      requestedModel: 'openai/gpt-6.1-sol',
      request: { kind: 'responses', body: { model: 'gpt-6.1-sol' } } as never,
      fraudHeaders: {} as never,
      userId: owner.kiloUserId as string,
      organizationId: null,
      sessionId: null,
      taskId: null,
      isNonTrialEnterprise: false,
      search: '',
      method: 'POST',
    });
  }

  it('disables the connection when OpenAI refuses the account, and passes the 403 on', async () => {
    const result = await send(
      jsonResponse(403, {
        error: {
          message: 'The ChatGPT user is not eligible for subscription sharing.',
          code: 'subscription_sharing_user_not_eligible',
        },
      })
    );

    expect(result.type === 'success' && result.response.status).toBe(403);
    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection).toMatchObject({
      status: 'error',
      error_message: OPENAI_CHATGPT_NOT_ELIGIBLE_MESSAGE,
    });
  });

  it('keeps the connection on another 403', async () => {
    await send(jsonResponse(403, { error: { code: 'subscription_sharing_route_not_supported' } }));

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(true);
    expect(stored?.connection.status).toBe('connected');
  });

  const RECONNECTED_TOKEN = 'reconnected-access-token';

  function usageLimitResponse(): Response {
    return jsonResponse(429, {
      error: {
        message: 'The app usage limit for this account was exceeded.',
        code: 'subscription_sharing_usage_limit_exceeded',
      },
    });
  }

  it('records a plan limit on the connection that served the request', async () => {
    const result = await send(usageLimitResponse());

    expect(result.type === 'success' && result.response.status).toBe(429);
    await expect(readOpenAiChatGptUsageLimit(owner)).resolves.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
    });
  });

  it('leaves a reconnected row without a limit that the replaced credential reported', async () => {
    // The person reconnects while a request on the previous credential is in
    // flight; the reply for that request arrives afterwards.
    await saveOpenAiChatGptConnection(
      owner,
      {
        access_token: RECONNECTED_TOKEN,
        refresh_token: 'refresh',
        expires_at: 1_800_000_000,
        issuer: 'https://auth.openai.com',
        client_id: 'client-id',
        subject: 'subject',
        connected_at: '2026-10-05T00:00:00.000Z',
        status: 'connected',
      },
      owner.kiloUserId as string
    );

    await send(usageLimitResponse());
    await expect(readOpenAiChatGptUsageLimit(owner)).resolves.toBeNull();

    // The credential the row holds now still records its own limit.
    jest
      .mocked(applyProviderSpecificLogic)
      .mockImplementation(async (_provider, _model, _request, extraHeaders) => {
        extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER] = RECONNECTED_TOKEN;
      });
    await send(usageLimitResponse());
    await expect(readOpenAiChatGptUsageLimit(owner)).resolves.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
    });
  });
});
