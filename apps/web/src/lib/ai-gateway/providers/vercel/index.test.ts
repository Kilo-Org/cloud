import { describe, it, expect } from '@jest/globals';
import {
  getAnthropicProviderOptionsForVercel,
  hasCompatibleVercelInferenceProvider,
} from '@/lib/ai-gateway/providers/vercel';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

describe('getAnthropicProviderOptionsForVercel', () => {
  it('maps chat completion verbosity to Anthropic effort', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        verbosity: 'high',
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toEqual({
      effort: 'high',
    });
  });

  it('maps responses text verbosity to Anthropic effort', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        input: 'hello',
        text: { verbosity: 'low' },
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toEqual({
      effort: 'low',
    });
  });

  it('returns undefined when no Anthropic options are needed', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    };

    expect(getAnthropicProviderOptionsForVercel(request)).toBe(undefined);
  });
});

describe('hasCompatibleVercelInferenceProvider', () => {
  it('accepts when a translated OpenRouter provider is available on Vercel', () => {
    expect(hasCompatibleVercelInferenceProvider(['amazon-bedrock'], ['anthropic', 'bedrock'])).toBe(
      true
    );
  });

  it('rejects when none of the requested providers are available on Vercel', () => {
    expect(hasCompatibleVercelInferenceProvider(['google-vertex'], ['anthropic', 'bedrock'])).toBe(
      false
    );
  });

  it('rejects an empty only list when provider data is available', () => {
    expect(hasCompatibleVercelInferenceProvider([], ['anthropic'])).toBe(false);
  });

  it('accepts when the model has no cached provider entry', () => {
    expect(hasCompatibleVercelInferenceProvider(['google-vertex'], null)).toBe(true);
  });
});
