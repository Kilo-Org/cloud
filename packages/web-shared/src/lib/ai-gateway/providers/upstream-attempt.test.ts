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
import {
  getOpenAiChatGptStoredConnection,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { applyProviderSpecificLogic } from './apply-provider-specific-logic';
import {
  getOpenRouterModelsFromDatabase,
  getOpenRouterModelsMetadataFromDatabase,
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
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({ [model.id]: model });
    jest.mocked(getOpenRouterModelsFromDatabase).mockResolvedValue(new Set([model.id]));
    jest.mocked(getRawOpenRouterModels).mockResolvedValue({ data: [catalogEntry] });
    jest.mocked(getPreferredProviderOrderConfig).mockResolvedValue({
      rules: [{ includes: ['test/'], providers: ['preferred-route'] }],
    });
  });

  function attempt(providerId: string, userByok: BYOKResult[] | null) {
    jest.mocked(upstreamRequest).mockResolvedValue({
      type: 'success',
      response: jsonResponse(200, { ok: true }),
    } as never);
    return sendUpstreamAttempt({
      providerContext: { provider: { id: providerId }, userByok } as never,
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
      costLimit: { maximumMicrodollars: '500', availableBalanceMicrodollars: 2_000_000 },
    });
  }

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
      providerContext: { provider: { id: 'openrouter' }, userByok: null } as never,
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
      providerContext: {
        provider: { id: 'openai-chatgpt', chatGptOwner: owner },
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
});
