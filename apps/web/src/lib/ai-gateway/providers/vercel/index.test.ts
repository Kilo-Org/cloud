import { describe, it, expect } from '@jest/globals';
import { getAnthropicProviderOptionsForVercel } from '@/lib/ai-gateway/providers/vercel';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

describe('getAnthropicProviderOptionsForVercel', () => {
  it('enables summarized thinking for Opus 4.7 when reasoning is explicitly enabled', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-opus-4.7',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { enabled: true },
      },
    };

    expect(getAnthropicProviderOptionsForVercel('anthropic/claude-opus-4.7', request)).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
    });
  });

  it('maps chat completion verbosity to Anthropic effort', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hello' }],
        verbosity: 'high',
      },
    };

    expect(getAnthropicProviderOptionsForVercel('anthropic/claude-sonnet-4.5', request)).toEqual({
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

    expect(getAnthropicProviderOptionsForVercel('anthropic/claude-sonnet-4.5', request)).toEqual({
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

    expect(getAnthropicProviderOptionsForVercel('anthropic/claude-sonnet-4.5', request)).toBe(
      undefined
    );
  });
});
