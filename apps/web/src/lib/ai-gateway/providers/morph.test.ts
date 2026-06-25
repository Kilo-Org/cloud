import { describe, it, expect } from '@jest/globals';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { morphChatModels, isMorphModel } from '@/lib/ai-gateway/providers/morph';

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
  const EXPECTED: Record<string, { in: number; out: number; cache: number | null }> = {
    'morph/qwen3.5-397b': { in: 0.5, out: 3.5, cache: 0.3 },
    'morph/qwen3.6-27b': { in: 0.289, out: 2.4, cache: null },
    'morph/minimax-m2.7': { in: 0.279, out: 1.2, cache: null },
    'morph/minimax-m3': { in: 0.6, out: 2.4, cache: null },
    'morph/glm-5.2': { in: 1.1, out: 4.1, cache: 0.35 },
    'morph/deepseek-v4-flash': { in: 0.139, out: 0.278, cache: null },
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
});
