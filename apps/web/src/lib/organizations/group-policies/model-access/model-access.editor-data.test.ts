import { describe, expect, it } from '@jest/globals';
import { buildModelAccessPolicyExemptModels } from './model-access.editor-data';

describe('buildModelAccessPolicyExemptModels', () => {
  it('projects, labels, and sorts direct BYOK and custom LLM models', () => {
    const directByokModels = [
      { id: 'zai-coding/glm-5', name: 'Z.AI: GLM-5', pricing: { prompt: '0' } },
      { id: 'chutes-byok/qwen', name: 'Chutes: Qwen', canonical_slug: 'chutes-byok/qwen' },
    ];
    const customLlms = [
      { id: 'kilo-internal/zeta', name: 'Zeta', architecture: { modality: 'text->text' } },
      { id: 'kilo-internal/alpha', name: 'Alpha', opencode: { ai_sdk_provider: 'openai' } },
    ];

    expect(buildModelAccessPolicyExemptModels(directByokModels, customLlms)).toEqual([
      { id: 'chutes-byok/qwen', name: 'Chutes: Qwen', source: 'direct_byok' },
      { id: 'zai-coding/glm-5', name: 'Z.AI: GLM-5', source: 'direct_byok' },
      { id: 'kilo-internal/alpha', name: 'Alpha', source: 'custom_llm' },
      { id: 'kilo-internal/zeta', name: 'Zeta', source: 'custom_llm' },
    ]);
  });
});
