import { describe, it, expect } from '@jest/globals';
import { applyResolvedAutoModel } from './resolution';
import { KILO_AUTO_FREE_MODEL, KILO_AUTO_BALANCED_MODEL } from '@/lib/kilo-auto';
import { minimax_m25_free_model } from '@/lib/ai-gateway/providers/minimax';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

function chatCompletionsRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: KILO_AUTO_FREE_MODEL.id,
      messages: [],
      ...overrides,
    },
  };
}

describe('applyResolvedAutoModel - middle-out transform for minimax-m2.5:free', () => {
  it('injects transforms: ["middle-out"] when kilo-auto/free resolves to minimax on chat_completions', async () => {
    const request = chatCompletionsRequest();

    await applyResolvedAutoModel(
      {
        model: KILO_AUTO_FREE_MODEL.id,
        modeHeader: null,
        featureHeader: null,
        sessionId: null, // ensures resolution bypasses stepfun routing
        apiKind: 'chat_completions',
      },
      request,
      Promise.resolve(null),
      Promise.resolve(0)
    );

    expect(request.body.model).toBe(minimax_m25_free_model.public_id);
    expect((request.body as OpenRouterChatCompletionRequest).transforms).toEqual(['middle-out']);
  });

  it('does not overwrite transforms already set by the caller', async () => {
    const request = chatCompletionsRequest({ transforms: ['some-custom-transform'] });

    await applyResolvedAutoModel(
      {
        model: KILO_AUTO_FREE_MODEL.id,
        modeHeader: null,
        featureHeader: null,
        sessionId: null,
        apiKind: 'chat_completions',
      },
      request,
      Promise.resolve(null),
      Promise.resolve(0)
    );

    expect(request.body.model).toBe(minimax_m25_free_model.public_id);
    expect((request.body as OpenRouterChatCompletionRequest).transforms).toEqual([
      'some-custom-transform',
    ]);
  });

  it('treats an empty transforms array as unset and injects middle-out', async () => {
    const request = chatCompletionsRequest({ transforms: [] });

    await applyResolvedAutoModel(
      {
        model: KILO_AUTO_FREE_MODEL.id,
        modeHeader: null,
        featureHeader: null,
        sessionId: null,
        apiKind: 'chat_completions',
      },
      request,
      Promise.resolve(null),
      Promise.resolve(0)
    );

    expect((request.body as OpenRouterChatCompletionRequest).transforms).toEqual(['middle-out']);
  });

  it('does not inject transforms when the resolved model is not minimax-m2.5:free', async () => {
    const request = chatCompletionsRequest({ model: KILO_AUTO_BALANCED_MODEL.id });

    await applyResolvedAutoModel(
      {
        model: KILO_AUTO_BALANCED_MODEL.id,
        modeHeader: null,
        featureHeader: null,
        sessionId: null,
        apiKind: 'chat_completions',
      },
      request,
      Promise.resolve(null),
      Promise.resolve(0)
    );

    expect(request.body.model).not.toBe(minimax_m25_free_model.public_id);
    expect((request.body as OpenRouterChatCompletionRequest).transforms).toBeUndefined();
  });
});
