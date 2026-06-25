import { describe, it, expect } from '@jest/globals';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { morphChatModels, isMorphModel } from '@/lib/ai-gateway/providers/morph';
import {
  getAiSdkProvider,
  getGatewayOpenCodeSettings,
} from '@/lib/ai-gateway/providers/model-settings';

// Mirrors get-provider.ts: the OpenCode AI SDK provider selects the request kind
// a client sends. Morph only supports chat_completions, so any other kind is
// rejected by apiKindNotSupportedResponse before reaching the gateway.
function requestKindFor(aiSdkProvider: string | undefined) {
  if (aiSdkProvider === 'anthropic') return 'messages';
  if (aiSdkProvider === 'openai') return 'responses';
  return 'chat_completions';
}

// Resolves a kilo-exclusive model to its provider using the exact same lookup
// get-provider.ts performs for non-Vercel, non-BYOK gateway models.
function resolveGatewayProvider(gateway: string) {
  return Object.values(PROVIDERS).find(p => p.id === gateway) ?? PROVIDERS.OPENROUTER;
}

describe('Morph gateway provider', () => {
  it('exposes the Morph gateway with an OpenAI-compatible chat endpoint', () => {
    expect(PROVIDERS.MORPH.id).toBe('morph');
    expect(PROVIDERS.MORPH.apiUrl).toBe('https://api.morphllm.com/v1');
    expect(PROVIDERS.MORPH.supportedChatApis).toContain('chat_completions');
  });

  it('registers exactly the six large open-source models (no proprietary models)', () => {
    expect(morphChatModels.map(m => m.public_id).sort()).toEqual(
      [
        'morph/deepseek-v4-flash',
        'morph/glm-5.2',
        'morph/minimax-m2.7',
        'morph/minimax-m3',
        'morph/qwen3.5-397b',
        'morph/qwen3.6-27b',
      ].sort()
    );
    // Apply/compactor/warp-grep/embeddings must not be exposed through Kilo.
    expect(morphChatModels.some(m => /v3|apply|compact|warp|embed/i.test(m.public_id))).toBe(false);
  });

  it('resolves a Morph model and routes it to the Morph provider', () => {
    const model = findKiloExclusiveModel('morph/qwen3.6-27b');
    expect(model).not.toBeNull();
    expect(model!.gateway).toBe('morph');
    expect(model!.internal_id).toBe('morph-qwen36-27b');
    expect(resolveGatewayProvider(model!.gateway)).toBe(PROVIDERS.MORPH);
  });

  it('routes every registered Morph model to the Morph provider', () => {
    for (const m of morphChatModels) {
      expect(isMorphModel(m.public_id)).toBe(true);
      expect(findKiloExclusiveModel(m.public_id)).toBe(m);
      expect(resolveGatewayProvider(m.gateway)).toBe(PROVIDERS.MORPH);
    }
  });

  // Per-1M-token rates mirror Morph's canonical pricing
  // (https://www.morphllm.com/api/models/json). Cache-read is only billed for
  // qwen3.5 (0.3) and glm-5.2 (0.35, LMCache prefix reuse); the JSON omits the
  // glm rate, but Morph's calculateChatGlm52Cost bills it, so it is set here.
  const EXPECTED: Record<
    string,
    { in: number; out: number; cache: number | null; vision: boolean }
  > = {
    'morph/qwen3.5-397b': { in: 0.5, out: 3.5, cache: 0.3, vision: true },
    'morph/qwen3.6-27b': { in: 0.289, out: 2.4, cache: null, vision: false },
    'morph/minimax-m2.7': { in: 0.279, out: 1.2, cache: null, vision: false },
    'morph/minimax-m3': { in: 0.6, out: 2.4, cache: null, vision: true },
    'morph/glm-5.2': { in: 1.1, out: 4.1, cache: 0.35, vision: false },
    'morph/deepseek-v4-flash': { in: 0.139, out: 0.278, cache: null, vision: false },
  };

  it.each(morphChatModels)('prices $public_id to match Morph canonical pricing', model => {
    const want = EXPECTED[model.public_id];
    expect(want).toBeDefined();
    expect(model.pricing).toHaveLength(1);
    const p = model.pricing![0].pricing;
    expect(p.prompt_per_million).toBe(want.in);
    expect(p.completion_per_million).toBe(want.out);
    expect(p.input_cache_read_per_million ?? null).toBe(want.cache);
  });

  // Only qwen3.5-397b and minimax-m3 expose image input on Morph's gateway
  // (canonical JSON input_modalities includes "image").
  it.each(morphChatModels)(
    'flags $public_id vision support to match canonical modalities',
    model => {
      const want = EXPECTED[model.public_id];
      expect(want).toBeDefined();
      expect(model.flags.includes('vision')).toBe(want.vision);
      // Every Morph chat model is a reasoning model.
      expect(model.flags.includes('reasoning')).toBe(true);
    }
  );

  // Regression: getAiSdkProvider's name-based heuristics map any '*minimax*' id
  // to the Anthropic Messages API (and gpt/grok ids to the OpenAI Responses
  // API). The Morph gateway only speaks chat_completions, so every Morph model
  // must resolve to an OpenAI-compatible provider whose request kind the gateway
  // actually supports — otherwise OpenCode clients hit apiKindNotSupportedResponse.
  it.each(morphChatModels)(
    'maps $public_id to a chat_completions-compatible OpenCode provider',
    model => {
      const aiSdkProvider = getAiSdkProvider(model.public_id, null);
      expect(aiSdkProvider).toBe('openai-compatible');
      expect(getGatewayOpenCodeSettings(model.public_id)?.ai_sdk_provider).toBe(
        'openai-compatible'
      );

      const kind = requestKindFor(aiSdkProvider);
      expect(kind).toBe('chat_completions');
      expect(PROVIDERS.MORPH.supportedChatApis).toContain(kind);
    }
  );

  it('does not route the Morph MiniMax models through the Anthropic Messages API', () => {
    for (const id of ['morph/minimax-m2.7', 'morph/minimax-m3']) {
      expect(getAiSdkProvider(id, null)).not.toBe('anthropic');
    }
  });
});
