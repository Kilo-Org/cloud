import { describe, it, expect } from '@jest/globals';
import {
  applyKiloExclusiveModelSettings,
  convertFromKiloExclusiveModel,
  type KiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function makeModel(
  overrides: Partial<KiloExclusiveModel> & Pick<KiloExclusiveModel, 'internal_id'>
): KiloExclusiveModel {
  return {
    public_id: 'kilo/test-model',
    display_name: 'Test',
    description: '',
    context_length: 0,
    max_completion_tokens: 0,
    flags: [],
    ...overrides,
  };
}

function makeRequest(
  provider?: OpenRouterProviderConfig,
  model = 'public/id'
): GatewayRequest & { kind: 'chat_completions' } {
  const body: OpenRouterChatCompletionRequest = {
    model,
    messages: [],
    ...(provider ? { provider } : {}),
  } as OpenRouterChatCompletionRequest;
  return { kind: 'chat_completions', body };
}

describe('convertFromKiloExclusiveModel', () => {
  it('does not expose the internal model id in public metadata', () => {
    const model = makeModel({ internal_id: 'private/upstream-model' });
    const serialized = JSON.stringify(convertFromKiloExclusiveModel(model));
    expect(serialized).not.toContain('private/upstream-model');
  });
});

describe('applyKiloExclusiveModelSettings', () => {
  it('rewrites the public model id to the internal id', () => {
    const req = makeRequest(undefined, 'kilo/test-model');
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/real-model' }));
    expect(req.body.model).toBe('vendor/real-model');
  });

  it('leaves the provider config untouched', () => {
    const req = makeRequest({ only: ['anthropic'], zdr: true });
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/x' }));
    expect(req.body.provider).toEqual({ only: ['anthropic'], zdr: true });
  });

  it('does not clone shared provider configuration', () => {
    const sharedProvider: OpenRouterProviderConfig = { only: ['openai'] };
    const req = makeRequest(sharedProvider);
    applyKiloExclusiveModelSettings(req, makeModel({ internal_id: 'vendor/x' }));
    expect(req.body.provider).toBe(sharedProvider);
    expect(sharedProvider.only).toEqual(['openai']);
  });
});
