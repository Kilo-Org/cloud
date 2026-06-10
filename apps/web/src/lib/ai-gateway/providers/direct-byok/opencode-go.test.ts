import { getOpenCodeGoAiSdkProvider } from './opencode-go';
import type { DirectByokModel } from './types';

function model(id: string): DirectByokModel {
  return {
    id,
    name: id,
    context_length: 1_000_000,
    max_completion_tokens: 65_536,
  };
}

describe('getOpenCodeGoAiSdkProvider', () => {
  test.each(['minimax-m3', 'qwen3.7-plus'])('prefers Anthropic Messages for %s', modelId => {
    expect(getOpenCodeGoAiSdkProvider(model(modelId))).toBe('anthropic');
  });

  test('uses the provider default for other model families', () => {
    expect(getOpenCodeGoAiSdkProvider(model('deepseek-v4-flash'))).toBeUndefined();
  });
});
