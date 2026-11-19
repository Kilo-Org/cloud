import { describe, it, expect, jest } from '@jest/globals';
import { applyProviderSpecificLogic } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'debug').mockImplementation(() => undefined);

/**
 * Caller fallback ids must never reach Vercel. `removeModelsFallback` drops them before any
 * provider setting is built, so a fallback id in Kilo/OpenRouter spelling or as a `~` alias can
 * never be forwarded to Vercel untranslated.
 */
const CALLER_FALLBACK_MODELS = [
  'x-ai/grok-4',
  'z-ai/glm-4.6',
  'qwen/qwen3-coder',
  '~latest-anthropic',
];

function chatRequestWithFallbacks(): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      models: [...CALLER_FALLBACK_MODELS],
      provider: { only: ['anthropic'] },
    },
  };
}

async function applyToVercel(
  request: GatewayRequest,
  userByok: { decryptedAPIKey: string; providerId: 'anthropic' }[] | null
) {
  await applyProviderSpecificLogic(
    VERCEL_AI_GATEWAY,
    'anthropic/claude-sonnet-4.5',
    request,
    {},
    userByok,
    {},
    'user-1',
    null,
    null,
    null,
    false,
    null
  );
  return request.body.providerOptions?.gateway;
}

describe('applyProviderSpecificLogic Vercel fallback models', () => {
  it('sends no caller fallback id on the managed path', async () => {
    const request = chatRequestWithFallbacks();

    const gateway = await applyToVercel(request, null);

    expect(gateway?.models).toBeUndefined();
    expect(request.body).not.toHaveProperty('models');
  });

  it('sends no caller fallback id on the BYOK path', async () => {
    const request = chatRequestWithFallbacks();

    const gateway = await applyToVercel(request, [
      { decryptedAPIKey: 'sk-ant', providerId: 'anthropic' },
    ]);

    expect(gateway?.models).toBeUndefined();
    expect(gateway?.only).toEqual(['anthropic']);
    expect(request.body).not.toHaveProperty('models');
  });
});
